// scripts/sync-firestore-to-github.js
const { Octokit } = require('@octokit/rest');
const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Initialize GitHub client
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

const GITHUB_OWNER = process.env.GITHUB_REPOSITORY.split('/')[0];
const GITHUB_REPO = process.env.GITHUB_REPOSITORY.split('/')[1];
const COLLECTION_NAME = 'bugReports';

async function main() {
  console.log('Starting Firestore to GitHub Issues sync');

  // Query for bug reports that don't have GitHub issues yet
  const newReportsQuery = admin.firestore()
    .collection(COLLECTION_NAME)
    .where('githubIssueUrl', '==', null)
    .where('githubIssueError', '==', null)
    .limit(20);

  const snapshot = await newReportsQuery.get();
  console.log(`Found ${snapshot.size} new bug reports to process`);

  for (const doc of snapshot.docs) {
    const reportData = doc.data();
    const reportId = doc.id;
    
    try {
      console.log(`Processing bug report ${reportId}`);
      
      // Extract data from the bug report
      const {
        userAgent,
        deviceInfo,
        appVersion,
        description,
        userEmail,
        timestamp,
        stackTrace,
        screenshotUrl,
        steps,
        severity,
      } = reportData;

      // Format the issue body
      const issueBody = `
## Bug Report Details

**Report ID:** ${reportId}
**Date Reported:** ${new Date(timestamp?.toDate() || new Date()).toLocaleString()}
**Reporter Email:** ${userEmail || 'Not provided'}
**App Version:** ${appVersion || 'Not provided'}
**Severity:** ${severity || 'Not specified'}

### Device Information
- **Device:** ${deviceInfo?.model || 'Not provided'}
- **OS:** ${deviceInfo?.os || 'Not provided'}
- **User Agent:** ${userAgent || 'Not provided'}

### Description
${description || 'No description provided'}

${steps ? `### Steps to Reproduce\n${steps}` : ''}

${stackTrace ? `### Stack Trace\n\`\`\`\n${stackTrace}\n\`\`\`` : ''}

${screenshotUrl ? `### Screenshot\n![Screenshot](${screenshotUrl})` : ''}

---
*This issue was automatically created from a user bug report in the app.*
`;

      // Determine appropriate issue title
      const issueTitle = description 
        ? `[BUG] ${description.substring(0, 80)}${description.length > 80 ? '...' : ''}`
        : `[BUG] User reported issue (${reportId})`;

      // Create labels array based on data
      const labels = ['automated', 'bug'];
      
      // Add severity label if available
      if (severity) {
        labels.push(`severity:${severity}`);
      }

      // Create GitHub issue
      const response = await octokit.issues.create({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        title: issueTitle,
        body: issueBody,
        labels: labels,
      });

      // Update Firestore document with GitHub issue URL
      await admin.firestore().collection(COLLECTION_NAME).doc(reportId).update({
        githubIssueUrl: response.data.html_url,
        githubIssueNumber: response.data.number,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Created GitHub issue #${response.data.number} for bug report ${reportId}`);
    } catch (error) {
      console.error(`Error creating GitHub issue for ${reportId}:`, error);
      
      // Update document with error info
      await admin.firestore().collection(COLLECTION_NAME).doc(reportId).update({
        githubIssueError: error.message,
        lastAttempt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  // Also check for failed reports to retry
  const failedReportsQuery = admin.firestore()
    .collection(COLLECTION_NAME)
    .where('githubIssueError', '!=', null)
    .where('githubIssueUrl', '==', null)
    .where('retryCount', '<', 5) // Limit retries
    .limit(10);
  
  const failedReports = await failedReportsQuery.get();
  console.log(`Found ${failedReports.size} failed bug reports to retry`);
  
  for (const doc of failedReports.docs) {
    // Reset error fields to try again
    await doc.ref.update({
      githubIssueError: null,
      retryCount: admin.firestore.FieldValue.increment(1),
      lastRetry: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Reset error for bug report ${doc.id} to retry`);
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
