async function main() {
  console.log('Starting Firestore Feedback data export');
  console.log('Current working directory:', process.cwd());
  console.log('Logs directory absolute path:', path.resolve(LOGS_DIR));

  // Get all feedback items
  const feedbackQuery = admin
    .firestore()
    .collection('feedback')
    .orderBy('timestamp', 'desc')
    .limit(50); // Increased limit since we're just exporting

  const snapshot = await feedbackQuery.get();
  console.log(`Found ${snapshot.size} total feedback items`);

  // Prepare data for export
  const feedbackItems = await Promise.all(snapshot.docs.map(async (doc) => {
    const data = doc.data();
    const feedbackId = doc.id;

    // Handle screenshot if exists
    let screenshotData = null;
    if (data.screenshotId) {
      try {
        screenshotData = await reconstructScreenshot(data.screenshotId);
        if (screenshotData) {
          // Save screenshot locally
          const localPath = await saveScreenshotLocally(screenshotData, feedbackId);
          if (localPath) {
            data.localScreenshotPath = localPath;
          }
        }
      } catch (error) {
        console.error(`Error processing screenshot for ${feedbackId}:`, error);
      }
    }

    return {
      id: feedbackId,
      ...data,
      timestamp: data.timestamp?.toDate?.()?.toISOString() || new Date().toISOString(),
    };
  }));

  // Write to JSON file
  const exportPath = path.join(LOGS_DIR, 'feedback_export.json');
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
  console.log(`Created HTML report at ${path.join(LOGS_DIR, 'index.html')}`);

  // Write a summary file
  const summaryPath = path.join(LOGS_DIR, 'export_summary.txt');
  const summary = `
Feedback Export Summary
----------------------
Exported at: ${new Date().toISOString()}
Total items: ${feedbackItems.length}
With screenshots: ${feedbackItems.filter(item => item.screenshotId).length}
Export location: ${exportPath}
HTML report: ${path.join(LOGS_DIR, 'index.html')}
  `.trim();

  fs.writeFileSync(summaryPath, summary);
  console.log(`Written summary to ${summaryPath}`);
}

// Simplified HTML index creation
function createHtmlIndex(feedbackItems) {
  const htmlPath = path.join(LOGS_DIR, 'index.html');
  
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
        `<img src="${item.localScreenshotPath.replace(LOGS_DIR + '/', '')}" class="screenshot" />` 
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
}
