let path = {
  board: localStorage.getItem('board') || '',
  class: localStorage.getItem('class') || '',
  subject: '',
  chapter: ''
};

let chatHistory = [];

window.onload = function() {
  const savedBoard = localStorage.getItem('board');
  const savedClass = localStorage.getItem('class');

  if (savedBoard) {
    path.board = savedBoard;
    console.log("Loaded board:", path.board);
  }

  if (savedClass) {
    path.class = savedClass;
    console.log("Loaded class:", path.class);
  }
};

function selectSubject(selectElement) {
  path.subject = selectElement.value;
  console.log("Subject selected:", path.subject);
}

function selectChapter(selectElement) {
  path.chapter = selectElement.value;
  console.log("Chapter selected:", path.chapter);
}

// function getFullPath() {
//   // Get the current user's board and class from localStorage
//   const board = localStorage.getItem('board'); // default to CBSE if not set
//   const classLevel = localStorage.getItem('class');
  
//   // Get the selected subject and chapter
//   const subject = path.subject;
//   const chapter = path.chapter;
  
//   // Clean the chapter name by replacing spaces with underscores
//   const cleanChapter = chapter.replace(/ /g, '_');
  
//   return `gs://rag-project-storagebucket/${board}/Class_${classLevel}/${subject}/${cleanChapter}.pdf`;
// }

function getFullPath() {

  if (!path.board || !path.class || !path.subject || !path.chapter) {
    console.error("Missing path components:", path);
    throw new Error("Incomplete path configuration");
  }

  const board = path.board; 
  const classLevel = path.class;
  const subject = path.subject;
  const chapter = path.chapter;

  // Extract chapter number from selection (e.g., "Chapter 1: Introduction" → "1")
  const chapterNumber = chapter.match(/\d+/)?.[0] || '1';
  
  // Handle different file naming patterns
  print(`gs://rag-project-storagebucket/${board}/Class ${classLevel}/${subject}/chapter (${chapterNumber}).pdf`);
  return `gs://rag-project-storagebucket/${board}/Class ${classLevel}/${subject}/chapter (${chapterNumber}).pdf`;
}

function handleQuestion(event) {
  if (event.key === 'Enter' || event.type === 'click') {
    askQuestion();
  }
}

// function askQuestion() {
//   const input = document.getElementById('userQuestion');
//   const question = input.value.trim();
//   if (!question) return;

//   input.value = '';
//   displayUserMessage(question);
//   addToChatHistory('user', question);

//   const typingId = showTypingAnimation();

//   const fullPath = getFullPath();

//   fetch('/ask', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ path: fullPath, question })
//   })
//     .then(res => res.json())
//     .then(data => {
//       removeTypingAnimation(typingId);
//       const answer = data.answer || "❌ Sorry, I couldn't find an answer.";
//       displayBotMessage(answer);
//       addToChatHistory('bot', answer);
//       updateSidebarHistory();
//     })
//     .catch(err => {
//       console.error('Error:', err);
//       removeTypingAnimation(typingId);
//       displayBotMessage("❌ Something went wrong. Please try again.");
//     });
// }

async function askQuestion() {
    if (!path.subject || !path.chapter) {
      alert("Please select both a subject and chapter first");
    console.log("Missing path components:", path);
    displayBotMessage("Please select both a subject and chapter first");
    return;
  }
  try {
    // Get and validate user input
    const input = document.getElementById('userQuestion');
    if (!input) throw new Error('Chat input element not found');
    
    const question = input.value.trim();
    if (!question) {
      displayBotMessage("Please enter a question first");
      return;
    }

    // Clear input and display user message
    input.value = '';
    displayUserMessage(question);
    addToChatHistory('user', question);

    // Show typing indicator
    const typingId = showTypingAnimation();
    
    // Get and validate path
    let fullPath, pathComponents;
    try {
      // Assuming getFullPath() returns both the path string and components
      const pathResult = getFullPath();
      fullPath = pathResult.path;
      pathComponents = pathResult.components;
      
      if (process.env.NODE_ENV === 'development') {
        console.debug("Generated path:", fullPath);
        displayBotMessage(`🔍 Searching in: ${formatPathForDisplay(fullPath)}`);
      }
    } catch (pathError) {
      removeTypingAnimation(typingId);
      console.error("Path generation failed:", pathError);
      displayBotMessage("❌ Couldn't identify the study material. Please check your subject/chapter selection.");
      return;
    }

    // Make API request
    try {
      const response = await fetch('/ask', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Debug-Path': fullPath
        },
        body: JSON.stringify({ 
          path: fullPath, 
          question,
          context: {
            board: pathComponents.board,
            classLevel: pathComponents.class,
            subject: pathComponents.subject,
            chapter: pathComponents.chapter,
            timestamp: new Date().toISOString()
          }
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Server responded with ${response.status}`);
      }

      const data = await response.json();
      removeTypingAnimation(typingId);
      
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid response format from server');
      }

      const answer = data.answer || "❌ No answer could be generated for this question.";
      const sources = data.sources ? `\n\nSources: ${data.sources.join(', ')}` : '';
      
      displayBotMessage(answer + sources);
      addToChatHistory('bot', answer);
      
      if (document.getElementById('sidebar')) {
        updateSidebarHistory();
      }
    } catch (err) {
      removeTypingAnimation(typingId);
      console.error('API Error:', err);
      
      let errorMessage = "❌ Something went wrong. Please try again.";
      if (err.message.includes('Failed to fetch')) {
        errorMessage = "❌ Network error. Please check your connection.";
      } else if (err.message.includes('404')) {
        errorMessage = "❌ The study material couldn't be found. Please try a different chapter.";
      }
      
      displayBotMessage(errorMessage);
    }
  } catch (unexpectedError) {
    console.error("Unexpected error in askQuestion:", unexpectedError);
    displayBotMessage("❌ An unexpected error occurred. Please refresh the page and try again.");
  }
}

// Helper function to format path for display
function formatPathForDisplay(fullPath) {
  try {
    const parts = fullPath.split('/');
    const filename = parts.pop();
    return `${parts.slice(-2).join('/')}/${filename}`;
  } catch (e) {
    return fullPath;
  }
}

// Updated getFullPath() with validation
// function getFullPath() {
//   // Validate required fields
//   const required = ['board', 'class', 'subject', 'chapter'];
//   const missing = required.filter(field => !path[field]);
//   if (missing.length) {
//     throw new Error(`Missing path components: ${missing.join(', ')}`);
//   }

//   // Extract chapter number (more flexible approach)
//   let chapterNumber = '1'; // default
//   const numMatch = path.chapter.match(/(\d+)/);
//   if (numMatch) chapterNumber = numMatch[1];
  
//   // Clean components
//   const cleanPath = {
//     board: encodeURIComponent(path.board.replace(/\s+/g, '_')),
//     class: encodeURIComponent(path.class.replace(/\s+/g, '_')),
//     subject: encodeURIComponent(path.subject.replace(/\s+/g, '_')),
//     chapter: chapterNumber
//   };
//   console.debug("Clean path:", cleanPath); // Debug log
//   return `gs://rag-project-storagebucket/${cleanPath.board}/Class_${cleanPath.class}/${cleanPath.subject}/chapter_${cleanPath.chapter}.pdf`;
// }

function getFullPath() {
  // Validate path object exists
  if (!path || typeof path !== 'object') {
    throw new Error('Path configuration is missing or invalid');
  }

  // Validate required fields
  const required = ['board', 'class', 'subject', 'chapter'];
  const missing = required.filter(field => !path[field] || path[field].trim() === '');
  
  if (missing.length) {
    throw new Error(`Missing path components: ${missing.join(', ')}`);
  }

  // Extract chapter number with better validation
  const getChapterNumber = (chapterStr) => {
    if (!chapterStr) return '1'; // default
    
    // Match numbers in different formats (Chapter 1, Ch.3, Unit 5, etc.)
    const numMatch = chapterStr.toString().match(/(\d+)/);
    return numMatch ? numMatch[1] : '1';
  };

  // Clean and normalize path components
  const normalizeComponent = (str) => {
    return encodeURIComponent(
      str.toString()
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_\-]/g, '') // Remove special chars
        .toLowerCase()
    );
  };

  const cleanPath = {
    board: normalizeComponent(path.board),
    class: normalizeComponent(path.class),
    subject: normalizeComponent(path.subject),
    chapter: getChapterNumber(path.chapter)
  };

  // Validate numbers (class and chapter should be numeric)
  if (!/^\d+$/.test(cleanPath.class)) {
    console.warn(`Class value "${path.class}" may contain non-numeric characters`);
  }

  if (!/^\d+$/.test(cleanPath.chapter)) {
    console.warn(`Chapter value "${path.chapter}" may contain non-numeric characters`);
  }

  // Debug output in development only
  if (process.env.NODE_ENV === 'development') {
    console.debug("Generated clean path:", cleanPath);
  }

  // Construct final path
  return `gs://rag-project-storagebucket/${
    cleanPath.board
  }/Class_${
    cleanPath.class
  }/${
    cleanPath.subject
  }/chapter_${
    cleanPath.chapter
  }.pdf`;
}

async function submitPath() {
  document.getElementById('submitButton').disabled = true;

  if (!path.board || !path.class || !path.subject || !path.chapter) {
    alert("Please complete your selection.");
    document.getElementById('submitButton').disabled = false;
    return;
  }

  const fullPath = getFullPath();
  console.log(fullPath);
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
        showQuizButton();
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

function displayUserMessage(message) {
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `<div class="bubble user">${formatBotMessage(message)}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function formatBotMessage(text) {
  // Bold (**text**)
  let formattedText = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

  // Italic (*text* or _text_)
  formattedText = formattedText.replace(/(\*|_)(.*?)\1/g, '<i>$2</i>');

  // Handle lines
  const lines = formattedText.split('\n');
  let result = '';
  let inList = false;

  for (let line of lines) {
    line = line.trim();

    if (line.startsWith('* ')) {
      if (!inList) {
        result += '<ul>';
        inList = true;
      }
      result += `<li>${line.slice(2).trim()}</li>`;
    } else {
      if (inList) {
        result += '</ul>';
        inList = false;
      }
      if (line !== '') {
        result += `<p>${line}</p>`;
      }
    }
  }

  if (inList) {
    result += '</ul>';
  }

  return result;
}

function cleanText(text) {
  // Remove special characters like '*', '_', '#', etc.
  const cleanedText = text.replace(/[*_#`~]/g, ''); // You can add more unwanted characters in this regex if needed

  // You may also want to handle HTML tags (if you're concerned with those)
  return cleanedText.replace(/<\/?[^>]+(>|$)/g, ""); // Removes HTML tags
}

function displayBotMessage(message) {
  const chat = document.getElementById('chat');

  // Check if message contains a table
  if (message.includes('|')) {
    const lines = message.trim().split('\n');

    // Intro line
    const introLine = lines[0];

    // Table lines (skip separator lines)
    const tableLines = lines.slice(1).filter(line => {
      const trimmed = line.trim();
      // Remove lines that are ONLY pipes (|), hyphens (-), and spaces
      return !/^[-|\s]+$/.test(trimmed);
    });

    // 1. First bubble for intro line
    const introDiv = document.createElement('div');
    introDiv.className = 'message bot';
    introDiv.innerHTML = `<div class="bubble bot">${introLine}</div>`;
    chat.appendChild(introDiv);

    // 2. Create table
    const tableDiv = document.createElement('div');
    tableDiv.className = 'message bot';

    const table = document.createElement('table');

    // Table header
    const headerLine = tableLines[0];
    const headers = headerLine.split('|').map(h => h.trim()).filter(h => h.length > 0);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headers.forEach(headerText => {
      const th = document.createElement('th');
      th.innerHTML = headerText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    const tbody = document.createElement('tbody');
    for (let i = 1; i < tableLines.length; i++) {
      const line = tableLines[i];
      if (line.includes('|')) {
        const row = document.createElement('tr');
        const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell.length > 0);
        cells.forEach(cellText => {
          const td = document.createElement('td');
          // Make **bold** formatting work
          td.innerHTML = cellText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
          row.appendChild(td);
        });
        tbody.appendChild(row);
      }
    }
    table.appendChild(tbody);

    tableDiv.appendChild(table);
    chat.appendChild(tableDiv);

    chat.scrollTop = chat.scrollHeight;
  }
  else {
    const chat = document.getElementById('chat');
    const div = document.createElement('div');
    div.className = 'message bot';

    const bubble = document.createElement('div');
    bubble.className = 'bubble bot';

    // Split the message by double newlines into paragraphs
    let paragraphs = message.split(/\n\s*\n/);

    paragraphs.forEach(para => {
      const p = document.createElement('p');
      p.innerHTML = formatBotMessage(para.trim()); // Safe formatting
      bubble.appendChild(p);
    });

    div.appendChild(bubble);
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }
}

function showTypingAnimation() {
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  const typingId = `typing-${Date.now()}`;
  div.className = 'message bot typing';
  div.id = typingId;
  div.innerHTML = `<div class="bubble bot">Processing...</div>`;
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

function renderTableFromText(text) {
  const lines = text.trim().split('\n');

  if (lines.length < 3) {
    // Not enough lines for a valid table (header + separator + at least one row)
    return null;
  }

  const table = document.createElement('table');
  table.classList.add('generated-table'); // You can add CSS styling later

  // Create header
  const headerLine = lines[0];
  const headers = headerLine.split('|').map(h => h.trim()).filter(h => h);
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headers.forEach(headerText => {
    const th = document.createElement('th');
    th.innerHTML = headerText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>'); // Bold **text**
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Skip separator line (second line), start processing body rows
  const tbody = document.createElement('tbody');
  for (let i = 2; i < lines.length; i++) {
    const rowLine = lines[i];
    const cells = rowLine.split('|').map(c => c.trim()).filter(c => c);
    const tr = document.createElement('tr');
    cells.forEach(cellText => {
      const td = document.createElement('td');
      td.innerHTML = cellText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>'); // Bold **text**
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  return table;
}

function addToChatHistory(sender, text) {
  const timestamp = new Date().toLocaleTimeString();
  chatHistory.push({ sender: sender, text: text, timestamp: timestamp });
}

function updateSidebarHistory() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const historySection = sidebar.querySelector('h2'); // Assuming "History" is the first h2
  let historyHTML = '<h2>History</h2>';

  // Group history by date (simplified for "Today", "Yesterday", "Previous")
  let today = [];
  let yesterday = [];
  let previous = [];
  const todayDate = new Date().toLocaleDateString();
  const yesterdayDate = new Date(Date.now() - 86400000).toLocaleDateString(); // 24 hours ago

  chatHistory.forEach(item => {
    const messageDate = new Date().toLocaleDateString(); // Simplified: All messages are "today" for this example
    if (item.sender === 'user') { // Only include user messages (questions)
      if (messageDate === todayDate) {
        today.push(item);
      } else if (messageDate === yesterdayDate) {
        yesterday.push(item);
      } else {
        previous.push(item);
      }
    }
  });

  if (today.length > 0) {
    historyHTML += '<h6>Today</h6>';
    today.forEach(item => {
      historyHTML += `<p class="history-item" onclick="scrollToMessage('${item.timestamp}')">${item.text} <span class="history-time">(${item.timestamp})</span></p>`;
    });
  }

  if (yesterday.length > 0) {
    historyHTML += '<h6>Yesterday</h6>';
    yesterday.forEach(item => {
      historyHTML += `<p class="history-item" onclick="scrollToMessage('${item.timestamp}')">${item.text} <span class="history-time">(${item.timestamp})</span></p>`;
    });
  }

  if (previous.length > 0) {
    historyHTML += '<h6>Previous</h6>';
    previous.forEach(item => {
      historyHTML += `<p class="history-item" onclick="scrollToMessage('${item.timestamp}')">${item.text} <span class="history-time">(${item.timestamp})</span></p>`;
    });
  }

  sidebar.innerHTML = historyHTML;
}

function scrollToMessage(timestamp) {
  // Find the message with the matching timestamp and scroll to it
  const message = chatHistory.find(item => item.timestamp === timestamp);
  if (message) {
    const messageElement = Array.from(document.querySelectorAll('.message')).find(el => el.textContent.includes(message.text));
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

function logout() {
 fetch('/api/logout', {
     method: 'POST'
 })
     .then(() => {
         window.location.href = '/login.html';
     })
     .catch(err => {
        console.error('Logout error:', err);
     });
}

// Quiz functionality
let quizQuestions = [];
let userQuizAnswers = [];
let quizScore = 0;

function showQuizButton() {
  const quizButton = document.createElement('button');
  quizButton.id = 'quizButton';
  quizButton.textContent = 'Take Quiz on this Chapter';
  quizButton.style.margin = '10px 0';
  quizButton.style.padding = '10px 15px';
  quizButton.style.backgroundColor = '#4a1fb8';
  quizButton.style.color = 'white';
  quizButton.style.border = 'none';
  quizButton.style.borderRadius = '16px';
  quizButton.style.cursor = 'pointer';
  quizButton.onclick = startQuiz;
  
  const chatInput = document.getElementById('chatInput');
  chatInput.parentNode.insertBefore(quizButton, chatInput);
}

function startQuiz() {
  if (!path.chapter) {
    alert('Please select a chapter first');
    return;
  }

  const fullPath = `gs://rag-project-storagebucket/${path.board}/${path.class}/${path.subject}/${path.chapter}`;
  
  // Show loading message
  const loadingId = showTypingAnimation();
  
  fetch('/generate-quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fullPath })
  })
    .then(res => res.json())
    .then(data => {
      removeTypingAnimation(loadingId);
      if (data.questions && data.questions.length > 0) {
        quizQuestions = data.questions;
        displayQuizQuestions();
      } else {
        displayBotMessage("❌ Could not generate quiz questions. Please try again.");
      }
    })
    .catch(err => {
      console.error('Error:', err);
      removeTypingAnimation(loadingId);
      displayBotMessage("❌ Something went wrong while generating quiz.");
    });
}

function displayQuizQuestions() {
  const chat = document.getElementById('chat');
  chat.innerHTML = '';
  
  const quizContainer = document.createElement('div');
  quizContainer.className = 'quiz-container';
  
  const quizHeader = document.createElement('div');
  quizHeader.className = 'quiz-header';
  quizHeader.innerHTML = `
    <h3>Chapter Quiz</h3>
    <p>Answer the following ${quizQuestions.length} questions:</p>
  `;
  quizContainer.appendChild(quizHeader);
  
  quizQuestions.forEach((question, index) => {
    const questionDiv = document.createElement('div');
    questionDiv.className = 'quiz-question';
    
    let optionsHtml = question.options.map((option, i) => `
      <div class="quiz-option" onclick="selectAnswer(${index}, ${i})">
        <input type="radio" name="q${index}" id="q${index}_${i}">
        <label for="q${index}_${i}"> ${option}</label>
      </div>
    `).join('');
    
    questionDiv.innerHTML = `
      <div class="quiz-question-text">Question ${index + 1}: ${question.question}</div>
      <div class="quiz-options">${optionsHtml}</div>
    `;
    
    quizContainer.appendChild(questionDiv);
  });
  
  const submitDiv = document.createElement('div');
  submitDiv.innerHTML = `
    <button id="submitQuiz" onclick="submitQuiz()" class="quiz-submit-btn">
      Submit Quiz
    </button>
  `;
  quizContainer.appendChild(submitDiv);
  
  chat.appendChild(quizContainer);
  chat.scrollTop = chat.scrollHeight;
}

function selectAnswer(questionIndex, optionIndex) {
  userQuizAnswers[questionIndex] = optionIndex;
  
  // Clear all selected states for this question
  const questionDivs = document.querySelectorAll('.quiz-question');
  const currentQuestionDiv = questionDivs[questionIndex];
  
  if (currentQuestionDiv) {
    const options = currentQuestionDiv.querySelectorAll('.quiz-option');
    options.forEach((opt, i) => {
      opt.classList.remove('selected');
      if (i === optionIndex) {
        opt.classList.add('selected');
      }
    });
  }
}

function submitQuiz() {
  if (userQuizAnswers.length < quizQuestions.length) {
    alert('Please answer all questions before submitting.');
    return;
  }
  
  // Calculate score
  quizScore = 0;
  quizQuestions.forEach((question, index) => {
    if (userQuizAnswers[index] === question.correctAnswer) {
      quizScore++;
    }
  });
  
  // Display results
  displayQuizResults();
}
 
function displayQuizResults() {
  const chat = document.getElementById('chat');

  const topicPerformance = analyzeTopicPerformance();

  const resultsDiv = document.createElement('div');
  resultsDiv.className = 'performance-report';

  let resultsHtml = `
    <div class="quiz-header">
      <h3>Quiz Results</h3>
    </div>

    <div class="performance-metrics">
      <div class="metric-card">
        <div class="metric-label">Score</div>
        <div class="metric-value">${quizScore}/${quizQuestions.length}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Percentage</div>
        <div class="metric-value">${Math.round((quizScore / quizQuestions.length) * 100)}%</div>
      </div>
    </div>

    <div class="question-results">
      <h4>Detailed Results</h4>
  `;

  quizQuestions.forEach((question, index) => {
    const isCorrect = userQuizAnswers[index] === question.correctAnswer;
    const userAnswer = userQuizAnswers[index] !== undefined ?
      question.options[userQuizAnswers[index]] : "Not answered";
    const correctAnswer = question.options[question.correctAnswer];

    resultsHtml += `
      <div class="question-result ${isCorrect ? 'correct' : 'incorrect'}">
        <p><strong>Question ${index + 1}:</strong> ${question.question}</p>
        <p><strong>Your answer:</strong> ${userAnswer} ${isCorrect ? '✅' : '❌'}</p>
        ${!isCorrect ? `<p><strong>Correct answer:</strong> ${correctAnswer}</p>` : ''}
        <p><strong>Explanation:</strong> ${question.explanation}</p>
      </div>
    `;
  });

  resultsHtml += `
    <div class="weak-topics">
      <h4>Topic Performance</h4>
  `;

  topicPerformance.forEach(topic => {
    resultsHtml += `
      <div class="topic-item">
        <span class="topic-name">${topic.name}</span>
        <span class="topic-score">${topic.correct}/${topic.total} correct</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${(topic.correct / topic.total) * 100}%"></div>
      </div>
    `;
  });

  const weakTopics = topicPerformance.filter(t => t.correct / t.total < 0.6);
  if (weakTopics.length > 0) {
    resultsHtml += `
      <div class="recommendations">
        <h4>Recommendations</h4>
        <p>Based on your performance, we recommend reviewing these topics:</p>
        <ul>
    `;

    weakTopics.forEach(topic => {
      resultsHtml += `<li>${topic.name} (${Math.round((topic.correct / topic.total) * 100)}% correct)</li>`;
      if (topic.questions.length > 0) {
        resultsHtml += `
          <p>Example Questions (Review these):</p>
          <ul>
        `;
        topic.questions.forEach(qIndex => {
          resultsHtml += `<li>${quizQuestions[qIndex].question}</li>`;
        });
        resultsHtml += `</ul>`;
      }
    });

    resultsHtml += `
        </ul>
        <p>You can ask me questions about these topics to improve your understanding.</p>
      </div>
    `;
  } else {
    resultsHtml += `
      <div class="recommendations">
        <h4>Great Job!</h4>
        <p>You performed well on all topics. Keep up the good work!</p>
      </div>
    `;
  }

  resultsHtml += `
    <button onclick="returnToChat()" class="quiz-submit-btn" style="margin-top: 20px;">
      Return to Chat
    </button>
  </div>`;

  resultsDiv.innerHTML = resultsHtml;
  chat.appendChild(resultsDiv);
  chat.scrollTop = chat.scrollHeight;
}

function analyzeTopicPerformance() {
  const topics = {};

  quizQuestions.forEach((question, index) => {
    let topicName = question.topic || extractTopicFromQuestion(question.question); // Use question.topic if available

    if (topicName === "General") {
      topicName = extractTopicFromExplanation(question.explanation);
    }

    topicName = cleanTopicName(topicName);

    if (!topics[topicName]) {
      topics[topicName] = {
        name: topicName,
        total: 0,
        correct: 0,
        questions: [] // Store question indices for recommendations
      };
    }

    topics[topicName].total++;
    if (userQuizAnswers[index] === question.correctAnswer) {
      topics[topicName].correct++;
    }

    if (userQuizAnswers[index] !== question.correctAnswer) {
      topics[topicName].questions.push(index); // Store the index of the wrong question
    }
  });

  return Object.values(topics).sort((a, b) =>
    (a.correct / a.total) - (b.correct / b.total)
  );
}

function extractTopicFromQuestion(questionText) {
  // Remove question words and interrogatives
  const cleaned = questionText.replace(/^(what|why|how|when|where|which|who|name|list|describe|explain)\s+/i, '')
                             .replace(/\?/g, '')
                             .trim();
  
  // Take first meaningful phrase (first 6-8 words max)
  const words = cleaned.split(/\s+/);
  return words.slice(0, Math.min(8, words.length)).join(' ');
}

function extractTopicFromExplanation(explanation) {
  // Look for key topic indicators
  const patterns = [
    /(chapter|section|unit)\s[\d\.]+/i,         // "Chapter 1", "Section 2.3"
    /(called|known as|termed)\s["']?(.+?)["']?(\s|,|\.|$)/i, // "called photosynthesis"
    /(concept|principle|theory)\s(of|behind)\s(.+?)(\s|,|\.|$)/i, // "concept of diffusion"
    /(process|phenomenon)\s(of)\s(.+?)(\s|,|\.|$)/i  // "process of evaporation"
  ];
  
  for (const pattern of patterns) {
    const match = explanation.match(pattern);
    if (match) {
      return match[0].replace(/^(the|a|an)\s+/i, '').trim();
    }
  }
  
  // Fallback to first noun phrase
  const firstSentence = explanation.split(/[\.\?]/)[0];
  return firstSentence || "General";
}

function cleanTopicName(topic) {
  return topic
    .replace(/^(in|the|this|that|which|what|how|why)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,$/, '')
    .replace(/^(.{1,60})(\s|$).*/, '$1') // Limit to 60 chars
    .trim() || "General Concepts";
}

function returnToChat() {
  // Clear quiz data
  quizQuestions = [];
  userQuizAnswers = [];
  quizScore = 0;
  
  // Reset chat interface
  const chat = document.getElementById('chat');
  chat.innerHTML = `
    <div class="message bot"><div class="bubble bot">Hi! 👋 I'm your AI Guide.</div></div>
    <div class="message bot"><div class="bubble bot">Ready to continue learning?</div></div>
  `;
  
  // Re-enable chat input
  document.getElementById('userQuestion').disabled = false;
}