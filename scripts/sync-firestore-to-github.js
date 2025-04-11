const { Octokit } = require('@octokit/rest');
const admin = require('firebase-admin');

// Initialize Firebase Admin
// Initialize Firebase Admin
let serviceAccount;
try {
  const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!base64Key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set');
  }
  
  // Try different decoding approaches
  let decodedKey;
  try {
    // First method: standard base64 decoding
    decodedKey = Buffer.from(base64Key, 'base64').toString('utf8');
    
    // Check if result starts with a { character (valid JSON)
    if (!decodedKey.trim().startsWith('{')) {
      throw new Error('Not a valid JSON after decoding');
    }
  } catch (decodeError) {
    console.log("Standard base64 decoding failed, trying URL-safe base64...");
    // Try URL-safe base64 decoding
    decodedKey = Buffer.from(base64Key.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  }
  
  console.log("Decoded key (first 20 chars):", decodedKey.substring(0, 20) + "...");
  
  // Make sure we have valid JSON
  serviceAccount = JSON.parse(decodedKey);
  
  // Verify that the decoded object has the required fields
  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error('The decoded service account is missing required fields');
  }
} catch (error) {
  console.error('Error parsing Firebase service account:', error.message);
  console.error('Make sure the FIREBASE_SERVICE_ACCOUNT is properly base64 encoded');
  
  // Add more debugging info
  const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  console.error('Base64 key length:', base64Key.length);
  console.error('Base64 key starts with:', base64Key.substring(0, 10) + '...');
  
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Initialize GitHub client
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

// Repository and project configuration
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'dnre';
const GITHUB_REPO = process.env.GITHUB_REPO || 'APP';
const PROJECT_NAME = process.env.PROJECT_NAME || 'Dnre-bug-tracking';
const FEEDBACK_COLLECTION = 'feedback';
const SCREENSHOTS_COLLECTION = 'feedback_screenshots';
const DEFAULT_STATUS = 'status:reportado';

// Function to get project ID from project name
async function getProjectId() {
  try {
    // List all projects in the repo
    const { data: projects } = await octokit.projects.listForRepo({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
    });
    
    // Find the project with the matching name
    const project = projects.find(p => p.name === PROJECT_NAME);
    
    if (!project) {
      console.error(`Project "${PROJECT_NAME}" not found in ${GITHUB_OWNER}/${GITHUB_REPO}`);
      return null;
    }
    
    return project.id;
  } catch (error) {
    console.error('Error getting project ID:', error);
    return null;
  }
}

// Function to add an issue to a project
async function addIssueToProject(issueId, projectId) {
  try {
    const { data: column } = await octokit.projects.listColumns({
      project_id: projectId
    });
    
    // Find the first column (typically "To Do" or "Backlog")
    // We can also look for a specific column by name if needed
    if (column.length > 0) {
      const firstColumn = column[0];
      
      await octokit.projects.createCard({
        column_id: firstColumn.id,
        content_id: issueId,
        content_type: 'Issue'
      });
      
      console.log(`Added issue to project column "${firstColumn.name}"`);
      return true;
    } else {
      console.error('No columns found in project');
      return false;
    }
  } catch (error) {
    console.error('Error adding issue to project:', error);
    return false;
  }
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

async function main() {
  console.log(`Starting Firestore Feedback to GitHub Issues sync for ${GITHUB_OWNER}/${GITHUB_REPO}`);
  
  // Get project ID first
  const projectId = await getProjectId();
  if (!projectId) {
    console.error(`Cannot proceed: Project ${PROJECT_NAME} not found or cannot be accessed`);
    process.exit(1);
  }
  
  console.log(`Found project "${PROJECT_NAME}" with ID: ${projectId}`);

  // Query for feedback reports that don't have GitHub issues yet
  const newFeedbackQuery = admin.firestore()
    .collection(FEEDBACK_COLLECTION)
    .where('githubIssueUrl', '==', null)
    .where('githubIssueError', '==', null)
    .orderBy('timestamp', 'desc')
    .limit(10);

  const snapshot = await newFeedbackQuery.get();
  console.log(`Found ${snapshot.size} new feedback items to process`);

  for (const doc of snapshot.docs) {
    const feedbackData = doc.data();
    const feedbackId = doc.id;
    
    try {
      console.log(`Processing feedback ${feedbackId}`);
      
      // Extract data from the feedback
      const {
        text,
        app_version,
        build_number,
        platform,
        device_info,
        screenshot_ref,
        timestamp,
        user_email
      } = feedbackData;

      // Prepare screenshot
      let screenshotMarkdown = '';
      if (screenshot_ref) {
        console.log(`Retrieving screenshot ${screenshot_ref} for feedback ${feedbackId}`);
        const base64Image = await reconstructScreenshot(screenshot_ref);
        
        if (base64Image) {
          // Upload image to GitHub Gist since it's too large for issue body
          const gistInfo = await uploadScreenshotToGist(base64Image, feedbackId);
          
          if (gistInfo) {
            screenshotMarkdown = `### Screenshot
![Screenshot](${gistInfo.raw_url})

*[View full screenshot](${gistInfo.url})*`;
          } else {
            screenshotMarkdown = '*Screenshot was available but could not be uploaded*';
          }
        }
      }

      // Format the issue body
      const issueBody = `
## User Feedback

**Feedback ID:** ${feedbackId}
**Date Submitted:** ${timestamp?.toDate ? new Date(timestamp.toDate()).toLocaleString() : 'Unknown'}
**User Email:** ${user_email || 'Not provided'}
**App Version:** ${app_version || 'Unknown'}${build_number ? ` (${build_number})` : ''}
**Platform:** ${platform || 'Unknown'}

### Device Information
${Object.entries(device_info || {}).map(([key, value]) => `- **${key}:** ${value}`).join('\n')}

### Feedback Content
${text || 'No text content provided'}

${screenshotMarkdown}

---
*This issue was automatically created from user feedback submitted through the app.*
`;

      // Determine appropriate issue title
      const issueTitle = text 
        ? `[Feedback] ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`
        : `[Feedback] User feedback (${feedbackId})`;

      // Create labels array based on data - include default status
      const labels = ['feedback', 'from-app', DEFAULT_STATUS];
      
      // Add platform label if available
      if (platform) {
        labels.push(platform.toLowerCase().includes('ios') ? 'ios' : 'android');
      }

      // Create GitHub issue
      const response = await octokit.issues.create({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        title: issueTitle,
        body: issueBody,
        labels: labels,
      });
      
      // Add issue to project
      const addedToProject = await addIssueToProject(response.data.id, projectId);

      // Update Firestore document with GitHub issue URL
      await admin.firestore().collection(FEEDBACK_COLLECTION).doc(feedbackId).update({
        githubIssueUrl: response.data.html_url,
        githubIssueNumber: response.data.number,
        githubRepo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
        githubProject: PROJECT_NAME,
        addedToProject: addedToProject,
        status: 'Reportado',
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Created GitHub issue #${response.data.number} for feedback ${feedbackId} and added to project "${PROJECT_NAME}"`);
    } catch (error) {
      console.error(`Error creating GitHub issue for ${feedbackId}:`, error);
      
      // Update document with error info
      await admin.firestore().collection(FEEDBACK_COLLECTION).doc(feedbackId).update({
        githubIssueError: error.message,
        lastAttempt: admin.firestore.FieldValue.serverTimestamp(),
        retryCount: admin.firestore.FieldValue.increment(1) 
      });
    }
  }

  // Also check for failed reports to retry
  const failedFeedbackQuery = admin.firestore()
    .collection(FEEDBACK_COLLECTION)
    .where('githubIssueError', '!=', null)
    .where('githubIssueUrl', '==', null)
    .where('retryCount', '<', 3) // Limit retries
    .limit(5);
  
  const failedFeedback = await failedFeedbackQuery.get();
  console.log(`Found ${failedFeedback.size} failed feedback items to retry`);
  
  for (const doc of failedFeedback.docs) {
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
