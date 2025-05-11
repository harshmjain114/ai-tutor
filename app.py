import re
import os
import io
import json

import traceback
from flask import Flask, request, jsonify, render_template, redirect, url_for, session
from PyPDF2 import PdfReader
from google.cloud import storage
from sentence_transformers import SentenceTransformer
from google.cloud import aiplatform
from vertexai.generative_models import GenerativeModel
import firebase_admin
from firebase_admin import credentials, auth, firestore
import requests
from functools import wraps
from flask_mail import Mail, Message
import random
import time
from dotenv import load_dotenv
from datetime import datetime, timedelta
from chat import chat_bp


# Load environment variables
load_dotenv()


# Initialize Flask
app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY')
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=2)  # Session expires in 2 hours
app.register_blueprint(chat_bp)

# ===== Firebase Initialization =====
def initialize_firebase():
    """Initialize Firebase services exactly once"""
    if not firebase_admin._apps:
        try:
            cred_path = os.getenv('FIREBASE_CREDENTIALS_PATH')
            if not os.path.exists(cred_path):
                raise FileNotFoundError(f"Credentials file missing at {cred_path}")
            
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred)
            return firestore.client()
        except Exception as e:
            app.logger.error(f"CRITICAL: Firebase init failed - {str(e)}")
            raise
    return firestore.client()

# Initialize Firebase when module loads
try:
    db = initialize_firebase()
    app.logger.info("Firebase initialized successfully")
except Exception as e:
    db = None
    app.logger.error(f"WARNING: Firebase initialization failed - {str(e)}")

# ===== Configurations =====
os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = os.getenv('GOOGLE_APPLICATION_CREDENTIALS')
project_id = os.getenv('PROJECT_ID')
location = 'us-central1'
aiplatform.init(project=project_id, location=location)

# Initialize models
try:
    embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
    app.logger.info("Embedding model loaded successfully")
except Exception as e:
    app.logger.error(f"Failed to load embedding model: {str(e)}")
    embedding_model = None

# Email configuration
app.config['MAIL_SERVER'] = 'smtp.gmail.com'
app.config['MAIL_PORT'] = 587
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USE_SSL'] = False
app.config['MAIL_USERNAME'] = os.getenv('MAIL_USERNAME')
app.config['MAIL_PASSWORD'] = os.getenv('MAIL_PASSWORD')
app.config['MAIL_DEFAULT_SENDER'] = os.getenv('MAIL_DEFAULT_SENDER')
mail = Mail(app)

# ===== Helper Functions =====
# def validate_pdf_path(path):
#     """Validate the GCS PDF path format for your structure"""
#     if not path.startswith('gs://project-storagebucket/NCERT/'):
#         return False
    
#     parts = path.split('/')
#     if len(parts) < 7:  # gs://bucket/NCERT/Class X/Subject/chapter (X).pdf
#         return False
        
#     # Validate class format (Class 6 to Class 12)
#     class_part = parts[4]
#     if not re.match(r'Class (6|7|8|9|10|11|12)$', class_part):
#         return False
        
#     # Validate chapter format (chapter (X).pdf)
#     chapter_file = parts[-1]
#     if not re.match(r'chapter \(\d+\)\.pdf$', chapter_file):
#         return False
        
#     return True

def validate_pdf_path(path):
    """More flexible path validation for your bucket structure"""
    if not path.startswith('gs://project-storagebucket/'):
        return False
    
    parts = path.split('/')
    if len(parts) < 6:  # At least gs://bucket/NCERT/Class X/Subject/file.pdf
        return False
        
    # Validate class format (Class 6 to Class 12, case insensitive)
    class_part = parts[3].lower()
    if not re.match(r'(class|class )?(6|7|8|9|10|11|12)$', class_part):
        return False
        
    # Validate chapter file format (multiple patterns)
    chapter_file = parts[-1].lower()
    valid_patterns = [
        r'chapter[ _]?\(?\d+\)?\.pdf$',  # chapter (1).pdf, chapter_1.pdf, chapter1.pdf
        r'chapter[ _]\d+[ _].+\.pdf$',   # chapter 1 introduction.pdf
        r'unit[ _]?\d+\.pdf$'            # unit1.pdf, unit_1.pdf
    ]
    
    return any(re.match(p, chapter_file) for p in valid_patterns)
def load_pdf_from_gcs(bucket_name, file_path):
    """Load PDF content from Google Cloud Storage"""
    try:
        storage_client = storage.Client()
        bucket = storage_client.bucket(bucket_name)
        blob = bucket.blob(file_path)
        
        if not blob.exists():
            raise FileNotFoundError(f"File not found at gs://{bucket_name}/{file_path}")
            
        return blob.download_as_bytes()
    except Exception as e:
        app.logger.error(f"Error loading PDF from GCS: {str(e)}")
        raise

def split_pdf_into_chunks(pdf_bytes, chunk_size=1000):
    """Split PDF into manageable chunks with overlap"""
    try:
        pdf_stream = io.BytesIO(pdf_bytes)
        reader = PdfReader(pdf_stream)
        chunks = []
        
        for page in reader.pages:
            text = page.extract_text()
            if text:
                # Split text into chunks with overlap
                words = text.split()
                for i in range(0, len(words), chunk_size):
                    chunk = ' '.join(words[i:i+chunk_size])
                    chunks.append(chunk)
                    
        return chunks
    except Exception as e:
        app.logger.error(f"Error splitting PDF: {str(e)}")
        raise

def get_chunks_filename(bucket_name, file_path):
    """Generate consistent filename for storing chunks"""
    safe_path = file_path.replace('/', '_').replace('.', '_')
    return f"chunks/{bucket_name}_{safe_path}.json"

def store_chunks(bucket_name, file_path, chunks):
    """Store chunks in local filesystem with proper error handling"""
    try:
        chunks_filename = get_chunks_filename(bucket_name, file_path)
        os.makedirs(os.path.dirname(chunks_filename), exist_ok=True)
        
        with open(chunks_filename, 'w') as f:
            json.dump(chunks, f)
    except Exception as e:
        app.logger.error(f"Error storing chunks: {str(e)}")
        raise

def load_chunks(bucket_name, file_path):
    """Load chunks from local filesystem with proper error handling"""
    try:
        chunks_filename = get_chunks_filename(bucket_name, file_path)
        
        if os.path.exists(chunks_filename):
            with open(chunks_filename, 'r') as f:
                return json.load(f)
        return None
    except Exception as e:
        app.logger.error(f"Error loading chunks: {str(e)}")
        return None

def retrieve_relevant_chunks(chunks, query, top_k=3):
    """Retrieve most relevant chunks using semantic search"""
    try:
        if not chunks or not query:
            return []
            
        query_embedding = embedding_model.encode([query])[0]
        scored_chunks = []
        
        for chunk in chunks:
            chunk_embedding = embedding_model.encode([chunk])[0]
            # Use cosine similarity
            score = sum(q * c for q, c in zip(query_embedding, chunk_embedding))
            scored_chunks.append((score, chunk))
            
        scored_chunks.sort(reverse=True, key=lambda x: x[0])
        return [chunk for _, chunk in scored_chunks[:top_k]]
    except Exception as e:
        app.logger.error(f"Error retrieving chunks: {str(e)}")
        return []

def generate_answer(context, query, model_name="gemini-2.0-flash-001"):
    """Generate answer using Gemini model with proper error handling"""
    try:
        if not context or not query:
            return "I couldn't find enough context to answer that question."
            
        model = GenerativeModel(model_name)
        prompt = (
            f"You are an expert educational assistant. Provide detailed, structured answers to student questions.\n\n"
            f"Context:\n{context}\n\n"
            f"Question: {query}\n\n"
            f"Format your answer with:\n"
            f"- **Bold** for key terms\n"
            f"- *Italics* for emphasis\n"
            f"- Lists for multiple items\n"
            f"- Tables for comparative data\n"
            f"- Headings for sections\n"
            f"- Clear explanations with examples where needed\n\n"
            f"Answer in detail, covering all relevant aspects from the context. "
            f"If the question can't be answered from the context, say so explicitly.\n\n"
            f"Answer:"
        )
        
        response = model.generate_content(prompt)
        return response.text.strip()
    except Exception as e:
        app.logger.error(f"Error generating answer: {str(e)}")
        return "I encountered an error while generating an answer. Please try again."
# ===== Authentication Decorator =====
def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Authentication required'}), 401
        return f(*args, **kwargs)
    return wrapper

# ===== Routes =====
@app.route('/')
def index():
    if 'user' in session:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login_page'))

@app.route('/dashboard.html')
@login_required
def dashboard():
    return render_template('dashboard.html')

@app.route('/login.html')
def login_page():
    if 'user' in session:
        return redirect(url_for('dashboard'))
    return render_template('login.html')

@app.route('/register.html')
def register_page():
    if 'user' in session:
        return redirect(url_for('dashboard'))
    return render_template('register.html')

@app.route('/chat.html')
@login_required
def chat_page():
    return render_template('chat2.html')

@app.route('/quiz.html')
@login_required
def quiz_page():
    return render_template('quiz.html')

@app.route('/otp_verification.html')
def otp_verification_page():
    if 'registration_data' not in session:
        return redirect(url_for('register_page'))
    return render_template('otp_verification.html')

@app.route('/forgot-password.html')
def forgot_password_page():
    return render_template('forgot_password.html')

@app.route('/api/user')
@login_required
def get_user():
    try:
        user_email = session.get('user')
        if not user_email:
            return jsonify({'error': 'User not authenticated'}), 401
            
        user = auth.get_user_by_email(user_email)
        user_ref = db.collection('users').document(user.uid)
        user_data = user_ref.get().to_dict()
        
        if not user_data:
            return jsonify({'error': 'User data not found'}), 404
        
        return jsonify({
            'user': {
                'email': user.email,
                'name': user.display_name,
                'board': user_data.get('board', ''),
                'class': user_data.get('class', ''),
                'stream': user_data.get('stream', 'NA')
            }
        })
    except Exception as e:
        app.logger.error(f"Error getting user data: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/login', methods=['POST'])
def login():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'status': 'error', 'message': 'No data provided'}), 400
            
        email = data.get('email', '').strip()
        password = data.get('password', '').strip()
        
        if not email or not password:
            return jsonify({'status': 'error', 'message': 'Email and password are required'}), 400

        FIREBASE_API_KEY = os.getenv('FIREBASE_API_KEY')
        url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}"
        payload = {
            "email": email,
            "password": password,
            "returnSecureToken": True
        }
        
        response = requests.post(url, json=payload)
        result = response.json()

        if 'idToken' in result:
            session.permanent = True
            session['user'] = email
            return jsonify({'status': 'success'})
        else:
            error_msg = result.get('error', {}).get('message', 'Login failed')
            app.logger.warning(f"Login failed for {email}: {error_msg}")
            return jsonify({
                'status': 'error',
                'message': error_msg,
                'code': result.get('error', {}).get('code', '')
            }), 401
    except Exception as e:
        app.logger.error(f"Login error: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Internal server error'}), 500

@app.route('/api/register', methods=['POST'])
def register():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'status': 'error', 'message': 'No data provided'}), 400
            
        email = data.get('email', '').strip()
        password = data.get('password', '').strip()
        name = data.get('name', '').strip()
        board = data.get('board', '').strip()
        class_ = data.get('class', '').strip()
        stream = data.get('stream', 'NA').strip()

        if not all([email, password, name, board, class_]):
            return jsonify({'status': 'error', 'message': 'Missing required fields'}), 400

        # Validate email format
        if '@' not in email or '.' not in email.split('@')[1]:
            return jsonify({'status': 'error', 'message': 'Invalid email format'}), 400

        # Validate password strength
        if len(password) < 6:
            return jsonify({'status': 'error', 'message': 'Password must be at least 8 characters'}), 400

        otp = random.randint(100000, 999999)
        otp_expiry = time.time() + 300  # 5 minutes expiry

        session['registration_data'] = {
            'email': email,
            'password': password,
            'name': name,
            'board': board,
            'class': class_,
            'stream': stream,
            'otp': otp,
            'otp_expiry': otp_expiry
        }

        try:
            msg = Message('Your OTP for Email Verification', recipients=[email])
            msg.body = f"Your OTP is {otp}. It will expire in 5 minutes."
            mail.send(msg)
            return jsonify({'status': 'success', 'message': 'OTP sent. Please verify your email.'})
        except Exception as e:
            session.pop('registration_data', None)
            app.logger.error(f"Error sending OTP email: {str(e)}")
            return jsonify({'status': 'error', 'message': 'Failed to send OTP. Please try again.'}), 500
    except Exception as e:
        app.logger.error(f"Registration error: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Internal server error'}), 500

@app.route('/api/verify-otp', methods=['POST'])
def verify_otp():
    try:
        data = request.get_json()
        if not data or not data.get('otp'):
            return jsonify({'status': 'error', 'message': 'OTP is required'}), 400

        reg_data = session.get('registration_data')
        if not reg_data:
            return jsonify({'status': 'error', 'message': 'Session expired. Please register again.'}), 400

        if time.time() > reg_data['otp_expiry']:
            session.pop('registration_data', None)
            return jsonify({'status': 'error', 'message': 'OTP expired. Please register again.'}), 400

        if int(data['otp']) != reg_data['otp']:
            return jsonify({'status': 'error', 'message': 'Invalid OTP'}), 400

        try:      
            user = auth.create_user(
                email=reg_data['email'],
                password=reg_data['password'],
                display_name=reg_data['name'],
                email_verified=True
            )

            user_ref = db.collection('users').document(user.uid)
            user_ref.set({
                'board': reg_data['board'],
                'class': reg_data['class'],
                'stream': reg_data['stream'],
                'createdAt': firestore.SERVER_TIMESTAMP,
                'lastLogin': firestore.SERVER_TIMESTAMP,
                'scores': {}  # Initialize scores dictionary
            })

            session['user'] = user.email
            session['user_name'] = user.display_name
            session.pop('registration_data', None)

            return jsonify({'status': 'success'})
        except auth.EmailAlreadyExistsError:
            return jsonify({'status': 'error', 'message': 'Email already registered'}), 400
        except Exception as e:
            error_msg = str(e)
            app.logger.error(f"Error during verification: {error_msg}")
            if "PERMISSION_DENIED" in error_msg:
                return jsonify({
                    'status': 'error',
                    'message': 'Server configuration error. Please contact support.',
                    'code': 'PERMISSION_DENIED'
                }), 403
            return jsonify({'status': 'error', 'message': error_msg}), 500
    except Exception as e:
        app.logger.error(f"OTP verification error: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Internal server error'}), 500

@app.route('/api/logout', methods=['POST'])
def logout():
    try:
        session.clear()
        return jsonify({'status': 'success'})
    except Exception as e:
        app.logger.error(f"Logout error: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/get-subjects')
@login_required
def get_subjects():
    try:
        user = auth.get_user_by_email(session.get('user'))
        user_ref = db.collection('users').document(user.uid)
        user_data = user_ref.get().to_dict()
        
        class_level = user_data.get('class', '')
        stream = user_data.get('stream', 'NA')
        
        subjects = []
        
        if not class_level:
            return jsonify({'error': 'Class information missing'}), 400
            
        if int(class_level) <= 10:
            subjects = ['English', 'Maths', 'Science', 'Social Studies']
        else:
            if stream == 'Science':
                subjects = ['Physics', 'Chemistry', 'Biology', 'Maths', 'English']
            elif stream == 'Commerce':
                subjects = ['Accountancy', 'Business Studies', 'Economics', 'Maths', 'English']
            else:
                subjects = ['History', 'Political Science', 'Geography', 'English']
        
        return jsonify(subjects)
    except Exception as e:
        app.logger.error(f"Error getting subjects: {str(e)}")
        return jsonify({'error': str(e)}), 500

# @app.route('/api/get-chapters')
# @login_required
# def get_chapters():
#     try:
#         subject = request.args.get('subject')
#         if not subject:
#             return jsonify({'error': 'Subject parameter is required'}), 400
        
#         # Get user's board and class from Firebase
#         user = auth.get_user_by_email(session.get('user'))
#         user_ref = db.collection('users').document(user.uid)
#         user_data = user_ref.get().to_dict()
        
#         board = user_data.get('board', 'CBSE')  # Default to CBSE
#         class_level = user_data.get('class', '10')  # Default to class 10
        
#         # In a real implementation, you would fetch chapters from your database
#         # based on board, class, and subject. This is a mock implementation.
#         mock_chapters = {
#             'Physics': ['Motion', 'Forces', 'Energy', 'Waves'],
#             'Chemistry': ['Matter', 'Atoms', 'Reactions', 'Periodic Table'],
#             'Maths': ['Algebra', 'Geometry', 'Calculus', 'Statistics'],
#             'English': ['Literature', 'Grammar', 'Composition', 'Comprehension'],
#             'Science': ['Biology', 'Chemistry', 'Physics', 'Environmental Science'],
#             'Social Studies': ['History', 'Geography', 'Civics', 'Economics']
#         }
        
#         chapters = mock_chapters.get(subject, [f"Chapter {i+1}" for i in range(5)])
#         formatted_chapters = [f"Chapter {i+1}: {chap}" for i, chap in enumerate(chapters)]
        
#         return jsonify(formatted_chapters)
#     except Exception as e:
#         app.logger.error(f"Error getting chapters: {str(e)}")
#         return jsonify({'error': str(e)}), 500


@app.route('/api/get-chapters')
@login_required
def get_chapters():
    try:
        subject = request.args.get('subject')
        if not subject:
            return jsonify({'error': 'Subject parameter is required'}), 400
        
        # Return fixed chapter list since your PDFs follow a numbered pattern
        chapters = [
                    "chapter (1)",
                    "chapter (2)",
                    "chapter (3)",
                    "chapter (4)",
                    "chapter (5)",
                    "chapter (6)",
                    "chapter (7)",
                    "chapter (8)"
        ]
        
        return jsonify(chapters)
    except Exception as e:
        app.logger.error(f"Error getting chapters: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/save-score', methods=['POST'])
@login_required
def save_score():
    try:
        data = request.get_json()
        subject = data.get('subject')
        score = data.get('score')
        
        if not subject or not score:
            return jsonify({'error': 'Missing subject or score'}), 400
            
        try:
            score = int(score)
            if score < 0 or score > 100:
                return jsonify({'error': 'Score must be between 0 and 100'}), 400
        except ValueError:
            return jsonify({'error': 'Invalid score format'}), 400
            
        user = auth.get_user_by_email(session.get('user'))
        user_ref = db.collection('users').document(user.uid)
        
        # Update the score and add timestamp
        user_ref.update({
            f'scores.{subject}': score,
            f'scoreHistory.{subject}': firestore.ArrayUnion([{
                'score': score,
                'timestamp': firestore.SERVER_TIMESTAMP
            }])
        })
        
        return jsonify({'status': 'success'})
    except Exception as e:
        app.logger.error(f"Error saving score: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/submit-path', methods=['POST'])
@login_required
def submit_path():
    try:
        data = request.get_json()
        path = data.get("path")

        if not path:
            return jsonify({"error": "Missing path"}), 400

        if not validate_pdf_path(path):
            return jsonify({"error": "Invalid path format"}), 400

        bucket_name = path.split('/')[2]
        file_path = "/".join(path.split('/')[3:])

        # Try multiple path variations to find the PDF
        pdf_content = None
        path_variations = [
            file_path,
            file_path.replace("chapter (", "Chapter ").replace(").pdf", ".pdf"),
            file_path.replace("Class ", "class "),  # Handle case sensitivity
            file_path.replace("(", "").replace(")", "")  # Handle chapter (1).pdf → chapter 1.pdf
        ]

        for path_variant in path_variations:
            try:
                pdf_content = get_pdf_from_storage(bucket_name, path_variant)
                file_path = path_variant  # Update to the successful path
                break
            except FileNotFoundError:
                continue

        if not pdf_content:
            return jsonify({"error": "PDF not found (tried multiple path variations)"}), 404

        chunks = load_chunks(bucket_name, file_path)
        if chunks is None:
            try:
                chunks = split_pdf_into_chunks(pdf_content)
                store_chunks(bucket_name, file_path, chunks)
                return jsonify({
                    "status": "success", 
                    "message": "PDF successfully processed into chunks", 
                    "chunks": len(chunks)
                })
            except Exception as e:
                app.logger.error(f"Error processing PDF: {str(e)}")
                return jsonify({"error": f"Failed to process PDF: {str(e)}"}), 500
        else:
            return jsonify({
                "status": "success", 
                "message": "Using cached PDF chunks", 
                "chunks": len(chunks)
            })

    except Exception as e:
        app.logger.error(f"Error submitting path: {str(e)}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/ask', methods=['POST'])
@login_required
def ask():
    try:
        data = request.get_json()
        path = data.get("path")
        question = data.get("question")

        if not path or not question:
            return jsonify({"error": "Missing path or question"}), 400

        if not validate_pdf_path(path):
            return jsonify({"error": "Invalid path format"}), 400

        bucket_name = path.split('/')[2]
        file_path = "/".join(path.split('/')[3:])

        chunks = load_chunks(bucket_name, file_path)
        if chunks is None:
            pdf_content = load_pdf_from_gcs(bucket_name, file_path)
            chunks = split_pdf_into_chunks(pdf_content)
            store_chunks(bucket_name, file_path, chunks)

        relevant_chunks = retrieve_relevant_chunks(chunks, question)
        if not relevant_chunks:
            return jsonify({"answer": "I couldn't find relevant information to answer your question."})

        context = " ".join(chunk.replace("\n", " ") for chunk in relevant_chunks).strip()
        answer = generate_answer(context, question)

        return jsonify({"answer": answer})
    except Exception as e:
        app.logger.error(f"Error answering question: {str(e)}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/generate-quiz', methods=['POST'])
@login_required
def generate_quiz():
    try:
        data = request.get_json()
        subject = data.get("subject")
        chapter = data.get("chapter")
        difficulty = data.get("difficulty", "medium")

        if not subject or not chapter:
            return jsonify({"error": "Missing subject or chapter"}), 400

        user = auth.get_user_by_email(session.get('user'))
        user_ref = db.collection('users').document(user.uid)
        user_data = user_ref.get().to_dict()
        
        board = user_data.get('board', 'NCERT')  # Default to NCERT
        class_level = user_data.get('class', '8')  # Default to class 8

        # Extract chapter number and construct full GCS path
        chapter_number = re.search(r'\d+', chapter).group() if re.search(r'\d+', chapter) else '1'
        gcs_path = f"gs://rag-project-storagebucket/{board}/Class {class_level}/{subject}/Chapter_{chapter_number}.pdf"

        # Split bucket and file path
        bucket_name = "rag-project-storagebucket"
        file_path = gcs_path.replace("gs://rag-project-storagebucket/", "")

        app.logger.debug(f"PDF path: {gcs_path}")

        try:
            pdf_content = load_pdf_from_gcs(bucket_name, file_path)
        except FileNotFoundError:
            # Try alternative path patterns if the first attempt fails
            alternative_paths = [
                f"{board}/Class {class_level}/{subject}/chapter ({chapter_number}).pdf",
                f"{board}/Class {class_level}/{subject}/chapter_{chapter_number}.pdf",
                f"{board}/Class {class_level}/{subject}/Chapter {chapter_number}.pdf"
            ]
            
            pdf_content = None
            for path in alternative_paths:
                try:
                    pdf_content = load_pdf_from_gcs(bucket_name, path)
                    break
                except FileNotFoundError:
                    continue
            
            if not pdf_content:
                return jsonify({"error": "PDF not found (tried multiple path variations)"}), 404

        # Rest of your existing code...

        # Process PDF
        chunks = split_pdf_into_chunks(pdf_content)
        store_chunks(bucket_name, file_path, chunks)
        context = " ".join(retrieve_relevant_chunks(chunks, "generate quiz question", top_k=10))

        # Generate quiz
        model = GenerativeModel("gemini-2.0-flash-001")
        prompt = (
            f"Generate 10 multiple choice questions based on the following educational content. "
            f"Difficulty level: {difficulty}. "
            f"Each question should be clear and complete. For each question, provide:\n"
            f"- A complete question text\n"
            f"- 4 possible options (labeled a, b, c, d)\n"
            f"- The correct answer (0-3 corresponding to options)\n"
            f"- A complete and detailed explanation\n"
            f"- The topic from the content\n"
            f"Format the response as a JSON array with these fields: question, options, correctAnswer, explanation, topic.\n"
            f"Content:\n{context}\n\nQuestions:"
        )

        response = model.generate_content(prompt)
        questions = json.loads(response.text)

        # Validate output
        validated_questions = []
        for q in questions[:10]:
            if all(k in q for k in ['question', 'options', 'correctAnswer', 'explanation', 'topic']) \
               and len(q['options']) == 4 and 0 <= q['correctAnswer'] <= 3:
                validated_questions.append(q)

        if not validated_questions:
            return jsonify({"error": "No valid questions generated"}), 500

        return jsonify({
            "questions": validated_questions,
            "subject": subject,
            "chapter": chapter,
            "generatedAt": datetime.now().isoformat()
        })

    except Exception as e:
        app.logger.error(f"Error generating quiz: {str(e)}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/forgot-password', methods=['POST'])
def api_forgot_password():
    try:
        email = request.get_json().get('email')
        if not email:
            return jsonify({'error': "Email is required"}), 400
            
        try:
            user = auth.get_user_by_email(email)
        except firebase_admin.auth.UserNotFoundError:
            return jsonify({'error': "Email not found"}), 404

        try:
            link = auth.generate_password_reset_link(email)
            msg = Message('Reset Your Password', recipients=[email])
            msg.body = f"Click the link to reset your password:\n\n{link}\n\nIf you didn't request this, ignore this email."
            mail.send(msg)
            return jsonify({"message": "Password reset email sent"})
        except Exception as e:
            app.logger.error(f"Error sending password reset email: {str(e)}")
            return jsonify({"error": "Failed to send password reset email"}), 500
    except Exception as e:
        app.logger.error(f"Forgot password error: {str(e)}")
        return jsonify({"error": str(e)}), 500

# Add this function to your helper functions
# def get_pdf_from_storage(bucket_name, file_path):
#     """Retrieve PDF from Google Cloud Storage with your structure"""
#     try:
#         storage_client = storage.Client()
#         bucket = storage_client.bucket(bucket_name)
        
#         # Handle the space in folder names (like "Class 10")
#         blob = bucket.blob(file_path)
        
#         if not blob.exists():
#             # Try alternative path formats if needed
#             alt_path = file_path.replace("Class ", "class ")
#             blob = bucket.blob(alt_path)
#             if not blob.exists():
#                 raise FileNotFoundError(f"File not found at gs://{bucket_name}/{file_path}")
                
#         return blob.download_as_bytes()
#     except Exception as e:
#         app.logger.error(f"Error loading PDF from GCS: {str(e)}")
#         raise

def get_pdf_from_storage(bucket_name, file_path):
    """Retrieve PDF from Google Cloud Storage with flexible naming"""
    try:
        storage_client = storage.Client()
        bucket = storage_client.bucket(bucket_name)
        
        # Try multiple filename patterns
        patterns_to_try = [
            file_path,  # Original path
            # file_path.replace("chapter (", "chapter_").replace(")", ""),  # chapter (1).pdf → chapter_1.pdf
            file_path.replace("chapter (", "Chapter ").replace(").pdf", ".pdf"),  # Chapter 1.pdf
            file_path.replace("Chapter_", "chapter "),  # chapter_1.pdf → chapter 1.pdf
            file_path.replace("chapter ", "Chapter "),  # chapter 1.pdf → Chapter 1.pdf
        ]
        
        for pattern in patterns_to_try:
            blob = bucket.blob(pattern)
            if blob.exists():
                return blob.download_as_bytes()
        
        raise FileNotFoundError(f"PDF not found (tried: {', '.join(patterns_to_try)}")
    except Exception as e:
        app.logger.error(f"Error loading PDF from GCS: {str(e)}")
        raise

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
    # app.run(debug=True)