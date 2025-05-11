document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const chatContainer = document.getElementById('chat');
    const userInput = document.getElementById('userQuestion');
    const sendButton = document.getElementById('sendButton');
    const submitButton = document.getElementById('submitButton');
    const logoutButton = document.getElementById('sidebar-logout');
    const userNameElement = document.getElementById('user-name');
    const historyContainer = document.getElementById('history-container');
    
    // Selection containers
    const boardOptions = document.getElementById('board-options');
    const classOptions = document.getElementById('class-options');
    const subjectOptions = document.getElementById('subject-options');
    const chapterOptions = document.getElementById('chapter-options');
    
    // Message elements
    const classMessage = document.getElementById('class-message');
    const subjectMessage = document.getElementById('subject-message');
    const chapterMessage = document.getElementById('chapter-message');
    
    // Section containers
    const submitContainer = document.getElementById('submit-container');
    const chatInputSection = document.getElementById('chat-input');

    // Chat state
    const state = {
        board: '',
        class: '',
        subject: '',
        chapter: '',
        chatHistory: []
    };

    // Initialize the app
    function init() {
        loadUserData();
        setupEventListeners();
        renderHistory();
    }

    // Load user data from backend
    function loadUserData() {
        fetch('/api/user')
            .then(response => {
                if (!response.ok) throw new Error('Not authenticated');
                return response.json();
            })
            .then(data => {
                userNameElement.textContent = data.user.name || data.user.email;
            })
            .catch(error => {
                console.error('Error loading user data:', error);
                window.location.href = '/login.html';
            });
    }

    // Set up all event listeners
    function setupEventListeners() {
        // Board selection
        document.querySelectorAll('#board-options .option-button').forEach(button => {
            button.addEventListener('click', () => {
                state.board = button.dataset.value;
                updateSelection(button, 'board');
                showClassSelection();
                updateSubmitButton();
            });
        });

        // Class selection
        document.querySelectorAll('#class-options .option-button').forEach(button => {
            button.addEventListener('click', () => {
                state.class = button.dataset.value;
                updateSelection(button, 'class');
                showSubjectSelection();
                updateSubmitButton();
            });
        });

        // Subject selection
        document.querySelectorAll('#subject-options .option-button').forEach(button => {
            button.addEventListener('click', () => {
                state.subject = button.dataset.value;
                updateSelection(button, 'subject');
                showChapterSelection();
                updateSubmitButton();
            });
        });

        // Chapter selection
        document.querySelectorAll('#chapter-options .option-button').forEach(button => {
            button.addEventListener('click', () => {
                state.chapter = button.dataset.value;
                updateSelection(button, 'chapter');
                updateSubmitButton();
            });
        });

        // Submit button
        submitButton.addEventListener('click', submitPath);

        // Send message button
        sendButton.addEventListener('click', sendMessage);
        userInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });

        // Logout button
        logoutButton.addEventListener('click', logout);
    }

    // Update selected button styling
    function updateSelection(selectedButton, type) {
        document.querySelectorAll(`#${type}-options .option-button`).forEach(button => {
            button.classList.remove('selected');
        });
        selectedButton.classList.add('selected');
    }

    // Show class selection after board is chosen
    function showClassSelection() {
        classMessage.classList.remove('hidden');
        classOptions.classList.remove('hidden');
        
        // Clear previous selections
        state.class = '';
        state.subject = '';
        state.chapter = '';
        
        // Populate class options based on board
        const classes = state.board === 'NCERT' ? 
            ['Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12'] :
            ['Class 9', 'Class 10', 'Class 11', 'Class 12'];
        
        classOptions.innerHTML = '';
        classes.forEach(cls => {
            const button = document.createElement('button');
            button.className = 'option-button';
            button.dataset.value = cls;
            button.textContent = cls;
            button.addEventListener('click', () => {
                state.class = cls;
                updateSelection(button, 'class');
                showSubjectSelection();
                updateSubmitButton();
            });
            classOptions.appendChild(button);
        });
        
        // Hide subsequent sections
        subjectMessage.classList.add('hidden');
        subjectOptions.classList.add('hidden');
        chapterMessage.classList.add('hidden');
        chapterOptions.classList.add('hidden');
    }

    // Show subject selection after class is chosen
    function showSubjectSelection() {
        subjectMessage.classList.remove('hidden');
        subjectOptions.classList.remove('hidden');
        
        // Clear previous selections
        state.subject = '';
        state.chapter = '';
        
        // Populate subject options based on class
        let subjects = ['Mathematics', 'Science'];
        if (['Class 11', 'Class 12'].includes(state.class)) {
            subjects = subjects.concat(['Physics', 'Chemistry', 'Biology', 'Computer Science']);
        }
        
        subjectOptions.innerHTML = '';
        subjects.forEach(subject => {
            const button = document.createElement('button');
            button.className = 'option-button';
            button.dataset.value = subject;
            button.textContent = subject;
            button.addEventListener('click', () => {
                state.subject = subject;
                updateSelection(button, 'subject');
                showChapterSelection();
                updateSubmitButton();
            });
            subjectOptions.appendChild(button);
        });
        
        // Hide subsequent sections
        chapterMessage.classList.add('hidden');
        chapterOptions.classList.add('hidden');
    }

    // Show chapter selection after subject is chosen
    function showChapterSelection() {
        chapterMessage.classList.remove('hidden');
        chapterOptions.classList.remove('hidden');
        
        // Clear previous selection
        state.chapter = '';
        
        // Populate chapter options (in a real app, this would come from backend)
        const chapters = [];
        for (let i = 1; i <= 10; i++) {
            chapters.push(`Chapter ${i}`);
        }
        
        chapterOptions.innerHTML = '';
        chapters.forEach(chapter => {
            const button = document.createElement('button');
            button.className = 'option-button';
            button.dataset.value = chapter;
            button.textContent = chapter;
            button.addEventListener('click', () => {
                state.chapter = chapter;
                updateSelection(button, 'chapter');
                updateSubmitButton();
            });
            chapterOptions.appendChild(button);
        });
    }

    // Update submit button state
    function updateSubmitButton() {
        const isComplete = state.board && state.class && state.subject && state.chapter;
        submitButton.disabled = !isComplete;
        
        if (isComplete) {
            submitContainer.classList.remove('hidden');
        } else {
            submitContainer.classList.add('hidden');
        }
    }

    // Send a user message
async function sendMessage() {
    const question = userInput.value.trim();
    if (!question || state.isProcessing) return;
    
    try {
        state.isProcessing = true;
        updateSubmitButton();
        userInput.value = '';
        
        addUserMessage(question);
        const processingId = showProcessingMessage();
        
        const response = await fetch('/api/chat/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: `gs://rag-project-storagebucket/${state.board}/${state.class}/${state.subject}/${state.chapter.replace(/ /g, '_')}`,
                question
            })
        });
        
        // Remove processing message
        if (document.getElementById(processingId)) {
            document.getElementById(processingId).remove();
        }
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || errorData.message || 'Failed to get answer');
        }
        
        const data = await response.json();
        addBotMessage(data.answer || "Sorry, I couldn't find an answer.");
        
        // Add debug information as a collapsible section
        if (data.debug) {
            addDebugInfo(data.debug);
        }
        
    } catch (error) {
        console.error('Error:', error);
        addBotMessage(error.message || "Something went wrong. Please try again.");
    } finally {
        state.isProcessing = false;
        updateSubmitButton();
    }
}

function addDebugInfo(debugData) {
    const debugDiv = document.createElement('div');
    debugDiv.className = 'message debug-info';
    
    const debugContent = `
        <div class="debug-toggle">Show Debug Info ▼</div>
        <div class="debug-content hidden">
            <h4>Debug Information</h4>
            <p><strong>Question:</strong> ${debugData.question}</p>
            
            <h5>Top Matching Chunks:</h5>
            <ol>
                ${debugData.top_chunks.map(chunk => `
                    <li>
                        <p><strong>Score:</strong> ${chunk.score.toFixed(4)}</p>
                        <p>${chunk.text}</p>
                    </li>
                `).join('')}
            </ol>
            
            <h5>Context Used:</h5>
            <div class="context-preview">${debugData.context_used}</div>
        </div>
    `;
    
    debugDiv.innerHTML = debugContent;
    chatContainer.appendChild(debugDiv);
    
    // Add toggle functionality
    const toggle = debugDiv.querySelector('.debug-toggle');
    const content = debugDiv.querySelector('.debug-content');
    
    toggle.addEventListener('click', () => {
        content.classList.toggle('hidden');
        toggle.textContent = content.classList.contains('hidden') ? 'Show Debug Info ▼' : 'Hide Debug Info ▲';
    });
}
    // Add a user message to the chat
    function addUserMessage(content) {
        const message = {
            content,
            sender: 'user',
            timestamp: new Date()
        };
        
        state.chatHistory.push(message);
        renderMessage(message);
        renderHistory();
    }

    // Add a bot message to the chat
    function addBotMessage(content) {
        const message = {
            content,
            sender: 'bot',
            timestamp: new Date()
        };
        
        state.chatHistory.push(message);
        renderMessage(message);
        renderHistory();
    }

    // Render a single message
    function renderMessage(message) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${message.sender}`;
        
        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = `bubble ${message.sender}`;
        bubbleDiv.textContent = message.content;
        
        messageDiv.appendChild(bubbleDiv);
        chatContainer.appendChild(messageDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    // Render the chat history in sidebar
    function renderHistory() {
        if (state.chatHistory.length === 0) {
            historyContainer.innerHTML = '<div class="empty-history">No chat history yet</div>';
            return;
        }
        
        // Group by date
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        const grouped = {
            today: [],
            yesterday: [],
            older: []
        };
        
        state.chatHistory.forEach(msg => {
            const msgDate = new Date(msg.timestamp);
            
            if (msgDate >= today) {
                grouped.today.push(msg);
            } else if (msgDate >= yesterday) {
                grouped.yesterday.push(msg);
            } else {
                grouped.older.push(msg);
            }
        });
        
        let html = '';
        
        // Today's messages
        if (grouped.today.length > 0) {
            html += '<div class="history-group"><h4>Today</h4>';
            grouped.today.forEach((msg, index) => {
                if (msg.sender === 'user') {
                    html += createHistoryItem(msg, index);
                }
            });
            html += '</div>';
        }
        
        // Yesterday's messages
        if (grouped.yesterday.length > 0) {
            html += '<div class="history-group"><h4>Yesterday</h4>';
            grouped.yesterday.forEach((msg, index) => {
                if (msg.sender === 'user') {
                    html += createHistoryItem(msg, index + grouped.today.length);
                }
            });
            html += '</div>';
        }
        
        // Older messages
        if (grouped.older.length > 0) {
            html += '<div class="history-group"><h4>Earlier</h4>';
            grouped.older.forEach((msg, index) => {
                if (msg.sender === 'user') {
                    const totalIndex = grouped.today.length + grouped.yesterday.length + index;
                    html += createHistoryItem(msg, totalIndex);
                }
            });
            html += '</div>';
        }
        
        historyContainer.innerHTML = html;
        
        // Add click handlers
        document.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                scrollToMessage(index);
            });
        });
    }

    // Create HTML for a history item
    function createHistoryItem(message, index) {
        const time = message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const content = message.content.length > 30 
            ? message.content.substring(0, 30) + '...' 
            : message.content;
        
        return `
            <div class="history-item" data-index="${index}">
                <span class="history-time">${time}</span>
                <span class="history-content">${content}</span>
            </div>
        `;
    }

    // Scroll to a specific message
    function scrollToMessage(index) {
        const messages = document.querySelectorAll('.message');
        if (index >= 0 && index < messages.length) {
            messages[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // Logout function
    function logout() {
        fetch('/api/logout', { method: 'POST' })
            .then(() => window.location.href = '/login.html')
            .catch(err => console.error('Logout error:', err));
    } 


    // Global state for processing messages
let currentProcessingMessageId = null;

// Show processing message with animation
function showProcessingMessage() {
    const chatContainer = document.getElementById('chat');
    const messageId = 'processing-' + Date.now();
    
    const processingDiv = document.createElement('div');
    processingDiv.id = messageId;
    processingDiv.className = 'message bot processing';
    
    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'bubble bot';
    bubbleDiv.innerHTML = `
        <div class="processing-message">
            <span class="processing-text">Processing PDF...</span>
            <span class="processing-dots">
                <span class="dot">.</span>
                <span class="dot">.</span>
                <span class="dot">.</span>
            </span>
        </div>
    `;
    
    processingDiv.appendChild(bubbleDiv);
    chatContainer.appendChild(processingDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    
    currentProcessingMessageId = messageId;
    return messageId;
}

// Update or remove processing message
function updateProcessingMessage(id, newMessage) {
    const processingElement = document.getElementById(id);
    if (processingElement) {
        if (newMessage) {
            processingElement.classList.remove('processing');
            processingElement.querySelector('.bubble').textContent = newMessage;
        } else {
            processingElement.remove();
        }
    }
    currentProcessingMessageId = null;
}

// Build the GCS path from selected options
function buildPathString() {
    const board = document.querySelector('#board-options .selected')?.dataset.value;
    const classLevel = document.querySelector('#class-options .selected')?.dataset.value;
    const subject = document.querySelector('#subject-options .selected')?.dataset.value;
    const chapter = document.querySelector('#chapter-options .selected')?.dataset.value;
    
    if (!board || !classLevel || !subject || !chapter) {
        throw new Error('Please select all options first');
    }
    
    // Format chapter name (replace spaces with underscores)
    const formattedChapter = chapter.replace(/ /g, '_');
    
    return `gs://rag-project-storagebucket/${board}/${classLevel}/${subject}/${formattedChapter}`;
}

// Main submit function
async function submitPath() {
    const submitButton = document.getElementById('submitButton');
    const userQuestionInput = document.getElementById('userQuestion');
    
    try {
        // Disable button and show processing
        submitButton.disabled = true;
        const processingId = showProcessingMessage();
        
        // Build path and make request
        const path = buildPathString();
        const response = await fetch('/api/chat/submit-path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        
        const result = await response.json();
        
        if (!response.ok) {
            // Handle error response
            updateProcessingMessage(processingId, 
                `❌ ${result.message || 'Error processing PDF'}\n${result.suggestion || ''}`
            );
            return;
        }
        
        // Success case
        updateProcessingMessage(processingId, '✅ PDF processed successfully!');
        userQuestionInput.disabled = false;
        userQuestionInput.focus();
        
    } catch (error) {
        console.error('Submit error:', error);
        
        if (currentProcessingMessageId) {
            updateProcessingMessage(currentProcessingMessageId, 
                `❌ ${error.message || 'Failed to process PDF'}`
            );
        } else {
            // Fallback error display
            const chatContainer = document.getElementById('chat');
            const errorDiv = document.createElement('div');
            errorDiv.className = 'message bot error';
            errorDiv.innerHTML = `<div class="bubble bot">❌ ${error.message || 'An error occurred'}</div>`;
            chatContainer.appendChild(errorDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
    } finally {
        submitButton.disabled = false;
    }
}


    // Initialize the application
    init();

});

