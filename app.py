import os
import io
import json
import traceback
from flask import Flask, request, jsonify, render_template
from PyPDF2 import PdfReader
from google.cloud import storage
from sentence_transformers import SentenceTransformer
from google.cloud import aiplatform
from vertexai.generative_models import GenerativeModel

# === Configuration ===
os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = 'keys/service_account.json'
project_id = 'my-rag-project-id'
location = 'us-central1'
aiplatform.init(project=project_id, location=location)

# === Initialize models ===
embedding_model = SentenceTransformer('all-MiniLM-L6-v2')

# === Flask app ===
app = Flask(__name__)

# === PDF Loader ===
def load_pdf_from_gcs(bucket_name, file_path):
    print(f"[DEBUG] Loading from bucket: {bucket_name}, file: {file_path}")
    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(file_path)
    return blob.download_as_bytes()

# === PDF Splitter ===
def split_pdf_into_chunks(pdf_bytes):
    print("[DEBUG] Splitting PDF into chunks...")
    pdf_stream = io.BytesIO(pdf_bytes)
    reader = PdfReader(pdf_stream)
    chunks = []
    for page_number, page in enumerate(reader.pages):
        text = page.extract_text()
        if text:
            print(f"[DEBUG] Page {page_number + 1} chunk size: {len(text)} chars")
            chunks.append(text)
    return chunks

# === Store Chunks ===
def store_chunks(bucket_name, file_path, chunks):
    # Generate a unique filename based on bucket and file path
    chunks_filename = f"{bucket_name}_{file_path.replace('/', '_')}_chunks.json"
    with open(chunks_filename, 'w') as f:
        json.dump(chunks, f)
    print(f"[DEBUG] Chunks stored in file: {chunks_filename}")

# === Load Chunks ===
def load_chunks(bucket_name, file_path):
    chunks_filename = f"{bucket_name}_{file_path.replace('/', '_')}_chunks.json"
    if os.path.exists(chunks_filename):
        with open(chunks_filename, 'r') as f:
            chunks = json.load(f)
        print(f"[DEBUG] Chunks loaded from file: {chunks_filename}")
        return chunks
    else:
        return None

# === Similarity Retrieval ===
def retrieve_relevant_chunks(chunks, query, top_k=3):
    query_embedding = embedding_model.encode([query])[0]
    print("[DEBUG] Query embedding computed.")
    scored_chunks = []
    for i, chunk in enumerate(chunks):
        chunk_embedding = embedding_model.encode([chunk])[0]
        score = sum(q * c for q, c in zip(query_embedding, chunk_embedding))
        print(f"[DEBUG] Chunk {i+1} similarity score: {score:.4f}")
        scored_chunks.append((score, chunk))
    scored_chunks.sort(reverse=True)
    top_chunks = [chunk for _, chunk in scored_chunks[:top_k]]
    print(f"[DEBUG] Top {top_k} chunks selected.")
    return top_chunks

# === Model Response Generator ===
def generate_answer(context, query):
    try:
        print("[DEBUG] Initializing Gemini model...")
        model = GenerativeModel("gemini-2.0-flash-001")  # or "gemini-2.0-flash-lite-001"
        print("[DEBUG] Gemini model initialized successfully.")

        prompt = (
            f"You are an educational assistant. Use the context below to answer the question.\n\n"
            f"Context:\n{context}\n\n"
            f"Question: {query}\n\n"
            f"Answer:"
        )
        print(f"[DEBUG] Prompt prepared for Gemini model. Preview:\n{prompt[:300]}...\n")

        response = model.generate_content(prompt)
        print(f"[DEBUG] Gemini model response received.")
        print(f"[DEBUG] Response Text: {response.text.strip()}")

        return response.text.strip()

    except Exception as e:
        print("[ERROR] Exception occurred during model response generation.")
        traceback.print_exc()
        raise e  # Let Flask handler return 500

# === Flask Routes ===
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/submit-path', methods=['POST'])
def submit_path():
    try:
        data = request.get_json()
        path = data.get("path")

        if not path:
            return jsonify({"error": "Missing path"}), 400

        bucket_name = path.split('/')[2]
        file_path = "/".join(path.split('/')[3:])
        
        # Check if chunks are already stored
        chunks = load_chunks(bucket_name, file_path)
        if chunks is None:
            print("[DEBUG] Loading PDF from GCS and splitting into chunks...")

            # Load PDF from GCS
            pdf_content = load_pdf_from_gcs(bucket_name, file_path)
            print(f"[DEBUG] PDF size: {len(pdf_content)} bytes")
            
            # Split PDF into chunks
            chunks = split_pdf_into_chunks(pdf_content)
            
            # Store chunks for future use
            store_chunks(bucket_name, file_path, chunks)
            
            return jsonify({
                "status": "success",
                "message": "PDF successfully divided into chunks and retrieved.",
                "chunks": chunks
            })
        else:
            print(f"[DEBUG] Using pre-split chunks for {file_path}.")
            return jsonify({
                "status": "success",
                "message": "PDF already divided into chunks.",
                "chunks": chunks
            })
    except Exception as e:
        print(f"[ERROR] {str(e)}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/ask', methods=['POST'])
def ask():
    print("Received data:", request.get_json())
    data = request.get_json()
    path = data.get("path")
    question = data.get("question")

    if not path or not question:
        return jsonify({"error": "Missing path or question"}), 400

    try:
        bucket_name = path.split('/')[2]
        file_path = "/".join(path.split('/')[3:])
        
        # Check if chunks are already stored
        chunks = load_chunks(bucket_name, file_path)
        if chunks is None:
            print("[DEBUG] Loading PDF from GCS and splitting into chunks...")
            pdf_content = load_pdf_from_gcs(bucket_name, file_path)
            print(f"[DEBUG] PDF size: {len(pdf_content)} bytes")
            chunks = split_pdf_into_chunks(pdf_content)
            store_chunks(bucket_name, file_path, chunks)  # Store chunks for future use
            # Returning a success message that PDF was divided into chunks
            return jsonify({
                "status": "success",
                "message": "PDF successfully divided into chunks and retrieved.",
                "chunks": chunks
            })
        else:
            print(f"[DEBUG] Using pre-split chunks for {file_path}.")

        print(f"[DEBUG] Total chunks: {len(chunks)}")
        relevant_chunks = retrieve_relevant_chunks(chunks, question)
        
        # Combine the relevant chunks into a single paragraph
        context = " ".join(chunk.replace("\n", " ") for chunk in relevant_chunks).strip()

        print(f"[DEBUG] Combined context length: {len(context)} characters")
        
        print("[DEBUG] Starting Gemini model answer generation...")
        answer = generate_answer(context, question)
        print("[DEBUG] Answer generation complete.")
        return jsonify({"answer": answer})
    except Exception as e:
        print(f"[ERROR] {str(e)}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# === Run App ===
if __name__ == '__main__':
    app.run(debug=True)
