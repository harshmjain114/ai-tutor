import os
import io
import json
import traceback
from flask import Blueprint, request, jsonify, render_template, session
from PyPDF2 import PdfReader
from google.cloud import storage
import numpy as np
from sentence_transformers import SentenceTransformer
from google.cloud import aiplatform
from vertexai.generative_models import GenerativeModel
import firebase_admin
from firebase_admin import credentials, auth
import requests
from functools import wraps
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Create Blueprint
chat_bp = Blueprint('chat', __name__, template_folder='templates')

# Initialize Firebase (only if not already initialized)
if not firebase_admin._apps:
    try:
        firebase_cred = credentials.Certificate(os.getenv('FIREBASE_CREDENTIALS_PATH'))
        firebase_admin.initialize_app(firebase_cred)
    except Exception as e:
        print(f"Firebase initialization error: {str(e)}")

# Initialize models
embedding_model = SentenceTransformer('all-MiniLM-L6-v2')

# Authentication Decorator
def chat_login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Authentication required'}), 401
        return f(*args, **kwargs)
    return wrapper

# Chat Routes
@chat_bp.route('/chat.html')
@chat_login_required
def chat_page():
    return render_template('chat2.html')

@chat_bp.route('/api/chat/user')
@chat_login_required
def get_chat_user():
    return jsonify({'user': {'email': session.get('user'), 'name': session.get('user_name', '')}})

@chat_bp.route('/api/chat/submit-path', methods=['POST'])
@chat_login_required
def submit_path():
    try:
        data = request.get_json()
        gcs_path = data.get("path")
        
        if not gcs_path:
            return jsonify({"error": "Missing GCS path"}), 400

        # Generate chunks path
        chunks_path = get_chunks_path(gcs_path)
        print(f"Looking for chunks file: {chunks_path}")

        # Check if chunks exist locally
        if os.path.exists(chunks_path):
            return jsonify({
                "status": "success", 
                "message": "Using cached chunks",
                "chunks_path": os.path.abspath(chunks_path)
            })

        # If not, process the PDF
        bucket_name = gcs_path.split('/')[2]
        file_path = '/'.join(gcs_path.split('/')[3:])
        
        # Try to load PDF with multiple path variations
        pdf_content = load_pdf_from_gcs(bucket_name, file_path)
        chunks = split_pdf_into_chunks(pdf_content)
        store_chunks_locally(chunks_path, chunks)

        return jsonify({
            "status": "success",
            "message": "PDF processed and chunks saved",
            "chunks_path": os.path.abspath(chunks_path),
            "chunk_count": len(chunks)
        })

    except FileNotFoundError as e:
        return jsonify({
            "status": "error",
            "message": str(e),
            "suggestion": "Please verify the PDF exists in GCS"
        }), 404
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@chat_bp.route('/api/chat/ask', methods=['POST'])
@chat_login_required
def ask():
    try:
        data = request.get_json()
        gcs_path = data.get("path")
        question = data.get("question")

        if not gcs_path or not question:
            return jsonify({"error": "Missing path or question"}), 400

        chunks_path = get_chunks_path(gcs_path)
        
        if not os.path.exists(chunks_path):
            return jsonify({
                "error": "Chunks not found",
                "solution": "Submit the PDF path first using /api/chat/submit-path"
            }), 404

        with open(chunks_path, 'r') as f:
            chunks = json.load(f)

        # Get relevant chunks with scores for debugging
        relevant_chunks_with_scores = retrieve_relevant_chunks_with_scores(chunks, question)
        
        # Convert float32 to native Python float for JSON serialization
        debug_chunks = []
        for chunk, score in relevant_chunks_with_scores:
            debug_chunks.append({
                "text": chunk[:200] + "..." if len(chunk) > 200 else chunk,
                "score": float(score)  # Convert numpy float32 to Python float
            })
        
        context = " ".join(chunk.replace("\n", " ") for chunk, _ in relevant_chunks_with_scores).strip()
        
        if not context:
            return jsonify({
                "error": "No relevant context found",
                "debug": {
                    "question": question,
                    "top_chunks": debug_chunks
                }
            }), 404

        answer = generate_answer(context, question)
        
        return jsonify({
            "answer": answer,
            "debug": {
                "question": question,
                "context_used": context[:500] + "..." if len(context) > 500 else context,
                "top_chunks": debug_chunks
            }
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

def retrieve_relevant_chunks_with_scores(chunks, query, top_k=3):
    """Find most relevant chunks with their similarity scores"""
    query_embedding = embedding_model.encode([query])[0]
    scored_chunks = []
    
    for chunk in chunks:
        chunk_embedding = embedding_model.encode([chunk])[0]
        score = np.dot(query_embedding, chunk_embedding)  # Using dot product for similarity
        scored_chunks.append((chunk, score))
    
    # Sort by score descending
    scored_chunks.sort(reverse=True, key=lambda x: x[1])
    return scored_chunks[:top_k]

# Helper Functions
def get_chunks_path(gcs_path):
    """Generate consistent local path for chunks JSON file."""
    parts = gcs_path.split('/')
    bucket_name = parts[2]
    file_path = '/'.join(parts[3:])
    return f"{bucket_name}_{file_path.replace('/', '_').replace(' ', '')}_chunks.json"

def load_pdf_from_gcs(bucket_name, file_path):
    """Load PDF from GCS with multiple path variations."""
    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)
    
    path_variations = [
        file_path,
        file_path + ".pdf",
        file_path.replace(" ", "_"),
        file_path.replace("Chapter ", "Chapter_"),
        file_path.replace("Class ", "class_"),
        file_path.lower(),
        file_path.upper()
    ]
    
    for variant in path_variations:
        blob = bucket.blob(variant)
        if blob.exists():
            return blob.download_as_bytes()
    
    raise FileNotFoundError(
        f"PDF not found at gs://{bucket_name}/{file_path}\n"
        f"Tried variations: {path_variations}"
    )

def split_pdf_into_chunks(pdf_bytes):
    """Convert PDF bytes to text chunks."""
    pdf_stream = io.BytesIO(pdf_bytes)
    reader = PdfReader(pdf_stream)
    return [page.extract_text() for page in reader.pages if page.extract_text()]

def store_chunks_locally(chunks_path, chunks):
    """Save chunks to local JSON file."""
    with open(chunks_path, 'w') as f:
        json.dump(chunks, f)

def retrieve_relevant_chunks(chunks, query, top_k=3):
    """Find most relevant chunks using semantic similarity with better scoring."""
    try:
        query_embedding = embedding_model.encode([query])[0]
        scored_chunks = []
        
        for i, chunk in enumerate(chunks):
            try:
                chunk_embedding = embedding_model.encode([chunk])[0]
                # Using cosine similarity
                score = sum(q * c for q, c in zip(query_embedding, chunk_embedding))
                scored_chunks.append((score, i, chunk))
            except Exception as e:
                print(f"Error encoding chunk {i}: {str(e)}")
                continue
        
        # Sort by score descending
        scored_chunks.sort(reverse=True, key=lambda x: x[0])
        
        # Return only chunks with positive scores
        relevant = [chunk for score, i, chunk in scored_chunks[:top_k] if score > 0]
        
        if not relevant:
            print("No relevant chunks found with positive similarity score")
            # Fallback to returning first chunks if nothing matches
            return chunks[:top_k]
            
        return relevant
        
    except Exception as e:
        print(f"Error in retrieve_relevant_chunks: {str(e)}")
        # Fallback to returning first chunks if error occurs
        return chunks[:top_k]
    
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
            f"- Bold for key terms\n"
            f"- Italics for emphasis\n"
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
# For standalone testing
if __name__ == '__main__':
    from flask import Flask
    app = Flask(__name__)
    app.secret_key = os.getenv('SECRET_KEY')
    app.register_blueprint(chat_bp)
    app.run(debug=True, port=5001)