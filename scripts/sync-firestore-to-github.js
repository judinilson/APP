const { Octokit } = require('@octokit/rest');
const { graphql } = require('@octokit/graphql');
const admin = require('firebase-admin');
const fs = require('fs');

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

// For GraphQL operations
const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${process.env.GITHUB_TOKEN}`
  }
});

// Repository and project configuration
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'dnre';
const GITHUB_REPO = process.env.GITHUB_REPO || 'APP';
const PROJECT_NAME = process.env.PROJECT_NAME || 'Dnre-bug-tracking';
const FEEDBACK_COLLECTION = 'feedback';
const SCREENSHOTS_COLLECTION = 'feedback_screenshots';
const DEFAULT_STATUS = 'status:reportado';

// Function to get project ID from project name - checks both org and repo projects
async function getProjectId() {
  try {
    console.log(`Looking for project #${PROJECT_NUMBER} for user "${GITHUB_OWNER}"`);
    
    // Try direct API request for the specific project (by number)
    try {
      const { data: project } = await octokit.request('GET /users/{username}/projects/{project_number}', {
        username: GITHUB_OWNER,
        project_number: PROJECT_NUMBER
      });
      
      console.log(`Found user project: ${project.name}`);
      return {
        id: project.id,
        number: project.number,
        type: 'user'
      };
    } catch (error) {
      console.error(`Error getting specific project: ${error.message}`);
    }
    
    // Fallback to listing all user projects
    try {
      const { data: userProjects } = await octokit.rest.projects.listForUser({
        username: GITHUB_OWNER,
        per_page: 100
      });
      
      console.log("Available projects for user:");
      userProjects.forEach(p => console.log(`- #${p.number}: ${p.name}`));
      
      // First try by number
      const projectByNumber = userProjects.find(p => p.number === PROJECT_NUMBER);
      if (projectByNumber) {
        console.log(`Found user project by number: ${projectByNumber.name}`);
        return {
          id: projectByNumber.id,
          number: projectByNumber.number,
          type: 'user'
        };
      }
      
      // Then try by name
      const projectByName = userProjects.find(p => p.name === PROJECT_NAME);
      if (projectByName) {
        console.log(`Found user project by name: ${projectByName.name}`);
        return {
          id: projectByName.id,
          number: projectByName.number,
          type: 'user'
        };
      }
    } catch (userError) {
      console.error(`Error listing user projects: ${userError.message}`);
    }
    
    console.error(`Could not find project #${PROJECT_NUMBER} or "${PROJECT_NAME}" for user "${GITHUB_OWNER}"`);
    return null;
  } catch (error) {
    console.error('Error getting project ID:', error);
    return null;
  }
}

// Function to add an issue to a project using GraphQL
async function addIssueToProject(issueId, projectInfo) {
  try {
    if (!projectInfo || !projectInfo.id) {
      console.error('Invalid project information');
      return false;
    }
    
    // Convert issueId to node ID if necessary
    let issueNodeId = issueId;
    if (!issueNodeId.startsWith('I_')) {
      // Fetch the node ID if we only have the issue number
      const { data: issue } = await octokit.rest.issues.get({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        issue_number: issueId
      });
      issueNodeId = issue.node_id;
    }
    
    // Add the issue to the project
    const result = await graphqlWithAuth(`
      mutation {
        addProjectV2ItemById(input: {
          projectId: "${projectInfo.id}"
          contentId: "${issueNodeId}"
        }) {
          item {
            id
          }
        }
      }
    `);
    
    console.log(`Added issue to project "${PROJECT_NAME}"`);
    return true;
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
  const projectInfo = await getProjectId();
  if (!projectInfo) {
    console.error(`Cannot proceed: Project ${PROJECT_NAME} not found or cannot be accessed`);
    process.exit(1);
  }
  
  console.log(`Found project "${PROJECT_NAME}" with ID: ${projectInfo.id}`);

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
      const addedToProject = await addIssueToProject(response.data.node_id, projectInfo);

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
