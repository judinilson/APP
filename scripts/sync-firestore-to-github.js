const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// Directory for logs and screenshots
const LOGS_DIR = "feedback_logs";
const SCREENSHOTS_DIR = path.join(LOGS_DIR, "screenshots");

// Ensure directories exist
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// Initialize Firebase Admin
try {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  
  if (!serviceAccountPath) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_PATH environment variable is not set");
  }
  
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  
  console.log(`Successfully initialized Firebase for project: ${serviceAccount.project_id}`);
} catch (error) {
  console.error("Error initializing Firebase:", error.message);
  process.exit(1);
}

/**
 * Reconstructs a screenshot from Firestore chunks
 */
async function reconstructScreenshot(screenshotId) {
  try {
    // Get screenshot metadata
    const screenshotDoc = await admin
      .firestore()
      .collection("feedback_screenshots")
      .doc(screenshotId)
      .get();

    if (!screenshotDoc.exists) {
      return null;
    }

    const metadata = screenshotDoc.data();
    const totalChunks = metadata.totalChunks;

    // Get all chunks
    const chunksSnapshot = await admin
      .firestore()
      .collection("feedback_screenshots")
      .doc(screenshotId)
      .collection("chunks")
      .orderBy("index")
      .get();

    if (chunksSnapshot.empty || chunksSnapshot.docs.length !== totalChunks) {
      return null;
    }

    // Reconstruct base64 image from chunks
    let base64Data = "";
    chunksSnapshot.docs.forEach((chunk) => {
      base64Data += chunk.data().data;
    });

    return base64Data;
  } catch (error) {
    console.error(`Error reconstructing screenshot ${screenshotId}:`, error);
    return null;
  }
}

/**
 * Saves a base64 screenshot to the local filesystem
 */
async function saveScreenshotLocally(base64Data, feedbackId) {
  if (!base64Data) return null;
  
  try {
    const filePath = path.join(SCREENSHOTS_DIR, `feedback_${feedbackId}.png`);
    fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
    console.log(`Saved screenshot for ${feedbackId}`);
    return filePath.replace(LOGS_DIR + '/', '');
  } catch (error) {
    console.error(`Error saving screenshot for ${feedbackId}:`, error);
    return null;
  }
}

/**
 * Creates a simple HTML index for browsing feedback
 */
function createHtmlIndex(feedbackItems) {
  const htmlPath = path.join(LOGS_DIR, "index.html");
  
  let html = `
<!DOCTYPE html>
<html>
<head>
  <title>Feedback Export</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .feedback-item { border: 1px solid #ddd; padding: 15px; margin-bottom: 20px; }
    .metadata { color: #666; }
    .screenshot { max-width: 300px; margin-top: 10px; }
  </style>
</head>
<body>
  <h1>Feedback Export</h1>
  <p>Exported at: ${new Date().toLocaleString()}</p>
  <p>Total items: ${feedbackItems.length}</p>
  
  <div class="feedback-items">
  `;
  
  feedbackItems.forEach((item) => {
    html += `
    <div class="feedback-item">
      <h3>Feedback ID: ${item.id}</h3>
      <div class="metadata">
        <p>Platform: ${item.platform || 'Unknown'}</p>
        <p>Version: ${item.app_version || 'Unknown'}</p>
        <p>User: ${item.user_email || 'Anonymous'}</p>
        <p>Time: ${new Date(item.timestamp).toLocaleString()}</p>
      </div>
      <div class="content">
        <p>${item.text || 'No content provided'}</p>
      </div>
      ${item.localScreenshotPath ? 
        `<img src="${item.localScreenshotPath}" class="screenshot" />` 
        : ''}
    </div>
    `;
  });
  
  html += `
  </div>
</body>
</html>
  `;
  
  fs.writeFileSync(htmlPath, html);
  console.log(`Created HTML index at ${htmlPath}`);
}

/**
 * Main function to retrieve feedback from Firestore and save it
 */
async function main() {
  console.log("Starting Firestore feedback export");
  console.log("Working directory:", process.cwd());
  
  try {
    // Get feedback data from Firestore
    const feedbackQuery = admin
      .firestore()
      .collection("feedback")
      .orderBy("timestamp", "desc")
      .limit(50);
    
    const snapshot = await feedbackQuery.get();
    console.log(`Found ${snapshot.size} feedback items`);
    
    // Process each feedback item
    const feedbackItems = await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data();
      const feedbackId = doc.id;
      
      // Handle screenshot if exists
      if (data.screenshotId) {
        try {
          const base64Data = await reconstructScreenshot(data.screenshotId);
          if (base64Data) {
            const localPath = await saveScreenshotLocally(base64Data, feedbackId);
            data.localScreenshotPath = localPath;
          }
        } catch (error) {
          console.error(`Error processing screenshot for ${feedbackId}:`, error);
        }
      }
      
      // Convert timestamp to string
      return {
        id: feedbackId,
        ...data,
        timestamp: data.timestamp?.toDate?.()?.toISOString() || new Date().toISOString()
      };
    }));
    
    // Save to JSON file
    const exportPath = path.join(LOGS_DIR, "feedback_export.json");
    fs.writeFileSync(
      exportPath,
      JSON.stringify({
        exported_at: new Date().toISOString(),
        total_items: feedbackItems.length,
        feedback: feedbackItems
      }, null, 2)
    );
    console.log(`Exported ${feedbackItems.length} items to ${exportPath}`);
    
    // Create HTML report
    createHtmlIndex(feedbackItems);
    
    // Write a summary file
    const summaryPath = path.join(LOGS_DIR, "export_summary.txt");
    const summary = `
Feedback Export Summary
----------------------
Exported at: ${new Date().toISOString()}
Total items: ${feedbackItems.length}
With screenshots: ${feedbackItems.filter(item => item.localScreenshotPath).length}
Export location: ${exportPath}
HTML report: ${path.join(LOGS_DIR, "index.html")}
`.trim();
    fs.writeFileSync(summaryPath, summary);
    console.log(`Written summary to ${summaryPath}`);
    
    return feedbackItems;
  } catch (error) {
    console.error("Error exporting feedback:", error);
    process.exit(1);
  }
}

// Execute the main function
main()
  .then(() => {
    console.log("Export completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Export failed:", error);
    process.exit(1);
  });
