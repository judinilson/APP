const { Octokit } = require('@octokit/rest');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin
let serviceAccount;
try {
  // Get the service account from file
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  
  if (!serviceAccountPath) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH environment variable is not set');
  }
  
  console.log(`Reading service account from: ${serviceAccountPath}`);
  
  // Read and parse the service account file
  try {
    const fileContent = fs.readFileSync(serviceAccountPath, 'utf8');
    serviceAccount = JSON.parse(fileContent);
  } catch (fileError) {
    console.error(`Error reading or parsing service account file: ${fileError.message}`);
    throw fileError;
  }
  
  // Verify that the service account has the required fields
  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error('The service account is missing required fields');
  }
  
  console.log(`Successfully loaded service account for project: ${serviceAccount.project_id}`);
} catch (error) {
  console.error('Error loading Firebase service account:', error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Initialize GitHub client
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

// Repository configuration
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'judinilson';
const GITHUB_REPO = process.env.GITHUB_REPO || 'APP';
const FEEDBACK_COLLECTION = 'feedback';
const SCREENSHOTS_COLLECTION = 'feedback_screenshots';
const DEFAULT_STATUS = 'status:reportado';
const FEEDBACK_LOG_FILE = 'feedback_processing_log.json';

// Create a directory for feedback logs and screenshots
const LOGS_DIR = 'feedback_logs';
const SCREENSHOTS_DIR = path.join(LOGS_DIR, "screenshots");

// Create directories if they don't exist
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  console.log(`Created directory: ${LOGS_DIR}`);
}

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  console.log(`Created directory: ${SCREENSHOTS_DIR}`);
}

async function reconstructScreenshot(screenshotId) {
  try {
    // Get screenshot metadata
    const screenshotDoc = await admin.firestore()
      .collection(SCREENSHOTS_COLLECTION)
      .doc(screenshotId)
      .get();
    
    if (!screenshotDoc.exists) {
      console.log(`Screenshot ${screenshotId} not found`);
      return null;
    }
    
    const metadata = screenshotDoc.data();
    const totalChunks = metadata.totalChunks;
    
    // Get all chunks
    const chunksSnapshot = await admin.firestore()
      .collection(SCREENSHOTS_COLLECTION)
      .doc(screenshotId)
      .collection('chunks')
      .orderBy('index')
      .get();
    
    if (chunksSnapshot.empty || chunksSnapshot.docs.length !== totalChunks) {
      console.log(`Missing chunks for screenshot ${screenshotId}`);
      return null;
    }
    
    // Reconstruct base64 image from chunks
    let base64Data = '';
    chunksSnapshot.docs.forEach(chunk => {
      base64Data += chunk.data().data;
    });
    
    return `data:${metadata.mimeType || 'image/png'};base64,${base64Data}`;
  } catch (error) {
    console.error(`Error reconstructing screenshot ${screenshotId}:`, error);
    return null;
  }
}

async function uploadScreenshotToGist(base64Image, feedbackId) {
  try {
    // Strip data URL prefix if present
    const base64Content = base64Image.includes(';base64,') 
      ? base64Image.split(';base64,')[1] 
      : base64Image;
    
    const gistResponse = await octokit.gists.create({
      files: {
        [`feedback_screenshot_${feedbackId}.txt`]: {
          content: base64Content
        }
      },
      description: `Screenshot for feedback ${feedbackId}`,
      public: false
    });
    
    return {
      url: gistResponse.data.html_url,
      raw_url: gistResponse.data.files[`feedback_screenshot_${feedbackId}.txt`].raw_url
    };
  } catch (error) {
    console.error(`Error uploading screenshot to Gist:`, error);
    return null;
  }
}

// Update your saveScreenshotLocally function with better error handling
async function saveScreenshotLocally(base64Image, feedbackId) {
  try {
    if (!base64Image) return null;
    
    // Make sure we have just the base64 data without the prefix
    const base64Data = base64Image.includes(';base64,') 
      ? base64Image.split(';base64,')[1] 
      : base64Image;
    
    const mimeType = base64Image.includes(';base64,') 
      ? base64Image.split(';base64,')[0].replace('data:', '') 
      : 'image/png';
    
    const extension = mimeType.includes('png') ? 'png' : 'jpg';
    
    // Ensure the screenshots directory exists
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      console.log(`Screenshots directory doesn't exist, creating it...`);
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }
    
    const filePath = path.join(SCREENSHOTS_DIR, `feedback_${feedbackId}.${extension}`);
    
    // Write the file
    try {
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      console.log(`Saved screenshot locally at: ${filePath}`);
      return filePath;
    } catch (writeError) {
      console.error(`Error writing screenshot file: ${writeError.message}`);
      console.error(`Path: ${filePath}`);
      console.error(`Directory exists: ${fs.existsSync(SCREENSHOTS_DIR)}`);
      console.error(`Directory is writable: ${fs.accessSync(SCREENSHOTS_DIR, fs.constants.W_OK)}`);
      return null;
    }
  } catch (error) {
    console.error(`Error saving screenshot locally:`, error);
    return null;
  }
}

// Similarly update updateFeedbackLog with better error handling
function updateFeedbackLog(feedbackData) {
  try {
    const logPath = path.join(LOGS_DIR, FEEDBACK_LOG_FILE);
    
    // Read existing log or create new one
    let logEntries = [];
    try {
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, 'utf8');
        logEntries = JSON.parse(logContent);
      }
    } catch (readError) {
      console.error(`Error reading log file: ${readError.message}`);
      // Continue with empty log if file is corrupted
    }
    
    // Add new entry
    logEntries.push(feedbackData);
    
    // Write updated log
    try {
      fs.writeFileSync(logPath, JSON.stringify(logEntries, null, 2), 'utf8');
      console.log(`Updated feedback log at: ${logPath}`);
    } catch (writeError) {
      console.error(`Error writing log file: ${writeError.message}`);
      console.error(`Path: ${logPath}`);
      console.error(`Directory exists: ${fs.existsSync(LOGS_DIR)}`);
      console.error(`Directory is writable: ${fs.accessSync(LOGS_DIR, fs.constants.W_OK)}`);
    }
    
    // Also create a simple HTML index for easy viewing
    try {
      createHtmlIndex(logEntries);
    } catch (htmlError) {
      console.error(`Error creating HTML index: ${htmlError.message}`);
    }
  } catch (error) {
    console.error(`Error updating feedback log:`, error);
  }
}

// Create a simple HTML index for easier manual review
function createHtmlIndex(logEntries) {
  const htmlPath = path.join(LOGS_DIR, 'index.html');
  
  let html = `
<!DOCTYPE html>
<html>
<head>
  <title>Feedback Log</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .feedback-item { border: 1px solid #ddd; padding: 15px; margin-bottom: 20px; border-radius: 5px; }
    .feedback-item h2 { margin-top: 0; }
    .metadata { color: #666; font-size: 0.9em; }
    .content { margin: 15px 0; }
    .screenshot { max-width: 300px; margin-top: 10px; }
    .github-link { background: #0366d6; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px; }
    .github-link:hover { background: #024ea7; }
    .timestamp { font-style: italic; }
  </style>
</head>
<body>
  <h1>Feedback Log</h1>
  <p>Last updated: ${new Date().toLocaleString()}</p>
  <p>Total entries: ${logEntries.length}</p>
  
  <div class="feedback-items">
  `;
  
  // Sort by date (newest first)
  logEntries.sort((a, b) => {
    return new Date(b.processedAt || 0) - new Date(a.processedAt || 0);
  });
  
  // Add each feedback entry
  logEntries.forEach(entry => {
    const date = entry.processedAt ? new Date(entry.processedAt).toLocaleString() : 'Unknown date';
    
    html += `
    <div class="feedback-item">
      <h2>${entry.title || 'Untitled feedback'}</h2>
      <div class="metadata">
        <p><strong>ID:</strong> ${entry.id}</p>
        <p><strong>Platform:</strong> ${entry.platform || 'Unknown'}</p>
        <p><strong>App version:</strong> ${entry.app_version || 'Unknown'} ${entry.build_number ? `(Build ${entry.build_number})` : ''}</p>
        <p><strong>User:</strong> ${entry.user_email || 'Anonymous'}</p>
        <p class="timestamp">Processed: ${date}</p>
      </div>
      
      <div class="content">
        <p>${entry.text || 'No content provided'}</p>
      </div>
      
      ${entry.localScreenshotPath ? `<img src="${entry.localScreenshotPath.replace(LOGS_DIR + '/', '')}" class="screenshot" />` : ''}
      ${entry.screenshotUrl ? `<p><a href="${entry.screenshotUrl}" target="_blank">View full screenshot</a></p>` : ''}
      
      ${entry.githubIssueUrl ? `<p><a href="${entry.githubIssueUrl}" target="_blank" class="github-link">View GitHub Issue #${entry.githubIssueNumber}</a></p>` : ''}
    </div>
    `;
  });
  
  html += `
  </div>
</body>
</html>
  `;
  
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`Created HTML index at: ${htmlPath}`);
}

async function main() {
  console.log(`Starting Firestore Feedback to GitHub Issues sync for ${GITHUB_OWNER}/${GITHUB_REPO}`);
  
  // Simplify the query to avoid the composite index requirement
  // Instead of using complex where clauses with ordering, just query for items without GitHub URLs
  const newFeedbackQuery = admin.firestore()
    .collection(FEEDBACK_COLLECTION)
    .where('githubIssueUrl', '==', null)
    .limit(10);

  const snapshot = await newFeedbackQuery.get();
  console.log(`Found ${snapshot.size} feedback items without GitHub issues`);
  
  // Filter in memory rather than in the query
  const validDocs = snapshot.docs.filter(doc => doc.data().githubIssueError === null);
  console.log(`Found ${validDocs.length} new feedback items to process`);

  // Sort by timestamp in memory (most recent first)
  validDocs.sort((a, b) => {
    const timestampA = a.data().timestamp?.toDate?.() || new Date(0);
    const timestampB = b.data().timestamp?.toDate?.() || new Date(0);
    return timestampB - timestampA;
  });

  for (const doc of validDocs) {
    const feedbackData = doc.data();
    const feedbackId = doc.id;
    
    // Processing code remains the same...
    try {
      console.log(`Processing feedback ${feedbackId}`);
      // ...rest of your processing code
    } catch (error) {
      // ...error handling
    }
  }

  // Simplify the failed feedback query too
  const failedFeedbackQuery = admin.firestore()
    .collection(FEEDBACK_COLLECTION)
    .where('githubIssueUrl', '==', null)
    .where('githubIssueError', '!=', null)
    .limit(5);
  
  const failedFeedback = await failedFeedbackQuery.get();
  
  // Filter retry counts in memory
  const docsToRetry = failedFeedback.docs.filter(doc => {
    const retryCount = doc.data().retryCount || 0;
    return retryCount < 3;
  });
  
  console.log(`Found ${docsToRetry.length} failed feedback items to retry`);
  
  for (const doc of docsToRetry) {
    // Reset error fields to try again
    await doc.ref.update({
      githubIssueError: null,
      lastRetry: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Reset error for feedback ${doc.id} to retry`);
  }
}

main()
  .then(() => {
    console.log('Sync completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Sync failed:', error);
    process.exit(1);
  });
