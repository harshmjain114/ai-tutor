let path = {
  board: '',
  class: '',
  subject: '',
  chapter: ''
};

function selectBoard(button, board) {
  path.board = board;
  updateSelection(button, 'board');
}

function selectClass(button, classLevel) {
  path.class = classLevel;
  updateSelection(button, 'class');
}

function selectSubject(button, subject) {
  path.subject = subject;
  updateSelection(button, 'subject');
}

function selectChapter(button, chapter) {
  path.chapter = chapter;
  updateSelection(button, 'chapter');
}

function updateSelection(button, type) {
  const options = document.querySelectorAll(`#${type}-options .option-button`);
  options.forEach(option => option.classList.remove('selected'));
  button.classList.add('selected');
}

function handleQuestion(event) {
  if (event.key === 'Enter' || event.type === 'click') {
    askQuestion();
  }
}

function askQuestion() {
  const input = document.getElementById('userQuestion');
  const question = input.value.trim();
  if (!question) return;

  input.value = '';
  displayUserMessage(question);

  // Show typing animation
  const typingId = showTypingAnimation();

  const fullPath = `gs://rag-project-storagebucket/${path.board}/${path.class}/${path.subject}/${path.chapter}`;

  fetch('/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fullPath, question: question })
  })
  .then(res => res.json())
  .then(data => {
    removeTypingAnimation(typingId);
    displayBotMessage(data.answer || "❌ Sorry, I couldn't find an answer.");
  })
  .catch(err => {
    console.error('Error:', err);
    removeTypingAnimation(typingId);
    displayBotMessage("❌ Something went wrong. Please try again.");
  });
}

function displayUserMessage(message) {
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `<div class="bubble user">${message}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function formatText(text) {
  // Replace text wrapped in ** with <strong> for bold
  const boldedText = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');  // Matches anything between ** and replaces with <strong> tag

  return boldedText;
}

function cleanText(text) {
  // Remove special characters like '*', '_', '#', etc.
  const cleanedText = text.replace(/[*_#`~],[**]/g, ''); // You can add more unwanted characters in this regex if needed
  
  // You may also want to handle HTML tags (if you're concerned with those)
  return cleanedText.replace(/<\/?[^>]+(>|$)/g, ""); // Removes HTML tags
}

function displayBotMessage(message) {
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'message bot';

  const cleanedMessage = cleanText(message);

  div.innerHTML = `<div class="bubble bot"><pre style="white-space: pre-wrap;">${message}</pre></div>`;
  
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function showTypingAnimation() {
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  const typingId = `typing-${Date.now()}`;
  div.className = 'message bot typing';
  div.id = typingId;
  div.innerHTML = `<div class="bubble bot">Typing...</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return typingId;
}

function removeTypingAnimation(typingId) {
  const typingElement = document.getElementById(typingId);
  if (typingElement) typingElement.remove();
}

// New helper: Show animated processing message
function showProcessingMessage(pathText) {
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  const id = `processing-${Date.now()}`;
  div.className = 'message bot typing';
  div.id = id;

  div.innerHTML = `
    <div class="bubble bot">
      Accessing content from the file in ${pathText}<br/>
      ⏳ Processing PDF... <span class="dots"><span>.</span><span>.</span><span>.</span></span>
    </div>
  `;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return id;
}

// New helper: Replace animated processing message with result
function updateProcessingMessage(id, newText) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('typing');
    const bubble = el.querySelector('.bubble');
    if (bubble) bubble.textContent = newText;
  }
}

async function submitPath() {
  document.getElementById('submitButton').disabled = true;

  if (!path.board || !path.class || !path.subject || !path.chapter) {
    alert("Please complete your selection.");
    document.getElementById('submitButton').disabled = false;
    return;
  }

  const fullPath = `gs://rag-project-storagebucket/${path.board}/${path.class}/${path.subject}/${path.chapter}`;

  // Show processing animation
  const processingId = showProcessingMessage(fullPath);

  await fetch('/submit-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fullPath })
  })
  .then(response => response.json())
  .then(result => {
    if (result.status === 'success') {
      updateProcessingMessage(processingId, result.message || '✅ PDF successfully divided into chunks.');
    } else {
      updateProcessingMessage(processingId, '❌ Error dividing PDF into chunks: ' + result.message);
    }
  })
  .catch(error => {
    console.error('Error:', error);
    updateProcessingMessage(processingId, "❌ Something went wrong. Please try again.");
  });

  document.getElementById('userQuestion').disabled = false;
  document.getElementById('submitButton').disabled = false;
  const chatContainer = document.getElementById('chat');
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function addMessage(text, sender = 'bot') {
  const chatContainer = document.getElementById('chat');
  const messageDiv = document.createElement('div');
  messageDiv.classList.add('message', sender);

  const bubbleDiv = document.createElement('div');
  bubbleDiv.classList.add('bubble', sender);
  bubbleDiv.textContent = text;

  messageDiv.appendChild(bubbleDiv);
  chatContainer.appendChild(messageDiv);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}
