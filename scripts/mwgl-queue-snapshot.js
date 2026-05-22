/**
 * MWGL Queue Snapshot - Dashboard Generator
 * Pulls school districts from Salesforce MWGL queue and generates interactive dashboard
 * Deploys to: GitHub Pages + Google Drive + Slack notification
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================================
// SALESFORCE CONFIGURATION
// ============================================================================

const SF_CONFIG = {
  instance: 'https://istation.lightning.force.com',
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  username: process.env.SF_USERNAME,
  password: process.env.SF_PASSWORD,
  securityToken: process.env.SF_SECURITY_TOKEN,
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Authenticate with Salesforce OAuth
 */
async function authenticateWithSalesforce() {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: SF_CONFIG.clientId,
      client_secret: SF_CONFIG.clientSecret,
      username: SF_CONFIG.username,
      password: SF_CONFIG.password + SF_CONFIG.securityToken,
    });

    const postData = params.toString();

    const options = {
      hostname: 'istation.lightning.force.com',
      port: 443,
      path: '/services/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          resolve(parsed.access_token);
        } else {
          reject(new Error('Auth failed: ' + res.statusCode + ' ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Query Salesforce SOQL for MWGL queue accounts
 */
async function queryMWGLAccounts(accessToken) {
  return new Promise((resolve, reject) => {
    const query = encodeURIComponent(
      "SELECT Id, Name, BillingState, BillingCity, Phone, Industry, AnnualRevenue, " +
      "(SELECT Id, Status FROM Cases WHERE Status != 'Closed' LIMIT 100) " +
      "FROM Account " +
      "WHERE Region__c = 'Midwest' OR Region__c LIKE '%Great Lakes%' " +
      "ORDER BY Name ASC LIMIT 500"
    );

    const options = {
      hostname: 'istation.lightning.force.com',
      port: 443,
      path: '/services/data/v60.0/query?q=' + query,
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error('Query failed: ' + res.statusCode + ' ' + data));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Generate HTML dashboard from account data
 */
async function generateDashboard(accounts, templatePath, outputPath) {
  const dashboardData = accounts.map(account => ({
    name: account.Name,
    state: account.BillingState || 'N/A',
    city: account.BillingCity || 'N/A',
    phone: account.Phone || 'N/A',
    industry: account.Industry || 'N/A',
    openCases: account.Cases && account.Cases.records ? account.Cases.records.length : 0,
  }));

  let html = fs.readFileSync(templatePath, 'utf-8');

  const dataScript = '<script>const dashboardData = ' + JSON.stringify(dashboardData) + ';<\/script>';
  html = html.replace('</body>', dataScript + '</body>');

  fs.writeFileSync(outputPath, html);
  return outputPath;
}

/**
 * Archive previous dashboard versions
 */
function archivePreviousVersions(docsDir) {
  try {
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
    }

    const archiveDir = path.join(docsDir, '_archive');
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    const files = fs.readdirSync(docsDir).filter(f =>
      f.startsWith('index-') && f.endsWith('.html')
    );

    if (files.length > 30) {
      files.sort().slice(0, files.length - 30).forEach(file => {
        const oldPath = path.join(docsDir, file);
        const archivePath = path.join(archiveDir, file);
        fs.copyFileSync(oldPath, archivePath);
        fs.unlinkSync(oldPath);
      });
    }

    console.log('Archived old versions (keeping last 30)');
    return archiveDir;
  } catch (error) {
    console.warn('Archive operation failed: ' + error.message);
    return null;
  }
}

/**
 * Create archive index file
 */
function createArchiveIndex(docsDir, archiveDir) {
  try {
    if (!archiveDir || !fs.existsSync(archiveDir)) return;

    const files = fs.readdirSync(archiveDir)
      .filter(f => f.endsWith('.html'))
      .map(f => ({
        name: f.replace('index-', '').replace('.html', ''),
        path: './_archive/' + f,
      }))
      .sort()
      .reverse()
      .slice(0, 20);

    let archiveHtml = '<!DOCTYPE html><html><head><title>MWGL Dashboard Archive</title>' +
      '<style>body{font-family:Arial;max-width:800px;margin:50px auto}h1{color:#4472C4}' +
      'a{color:#4472C4;text-decoration:none}a:hover{text-decoration:underline}</style></head>' +
      '<body><h1>MWGL Dashboard Archive</h1><p><a href="../">Back to Current Dashboard</a></p>' +
      '<h2>Previous Snapshots (Last 20)</h2><ul>';

    files.forEach(file => {
      archiveHtml += '<li><a href="' + file.path + '">' + file.name + '</a></li>';
    });

    archiveHtml += '</ul></body></html>';

    fs.writeFileSync(path.join(archiveDir, 'index.html'), archiveHtml);
    console.log('Created archive index');
  } catch (error) {
    console.warn('Archive index creation failed: ' + error.message);
  }
}

/**
 * Post summary to Slack with dashboard link
 */
async function postToSlack(slackChannel, summary, dashboardUrl) {
  return new Promise((resolve, reject) => {
    const payload = {
      channel: slackChannel,
      username: 'MWGL Queue Snapshot',
      icon_emoji: ':chart_with_upwards_trend:',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: summary } },
        { type: 'section', text: { type: 'mrkdwn', text: '<' + dashboardUrl + '|View Interactive Dashboard>' } },
      ],
      unfurl_links: false,
      unfurl_media: false,
    };

    const postData = JSON.stringify(payload);
    const token = process.env.SLACK_DAILY_BRIEFING_TOKEN;

    const options = {
      hostname: 'slack.com',
      port: 443,
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        Authorization: 'Bearer ' + token,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error('Slack post failed: ' + res.statusCode));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Copy files to Google Drive
 */
function copyToGoogleDrive(sourceFile, destFolder) {
  destFolder = destFolder || 'G:\\My Drive\\MWGL';
  try {
    if (!fs.existsSync(destFolder)) {
      fs.mkdirSync(destFolder, { recursive: true });
    }
    const destFile = path.join(destFolder, path.basename(sourceFile));
    fs.copyFileSync(sourceFile, destFile);
    console.log('Copied to Google Drive: ' + destFile);
    return destFile;
  } catch (error) {
    console.warn('Google Drive copy failed (local file valid): ' + error.message);
    return null;
  }
}

/**
 * Format summary for Slack message
 */
function formatSlackSummary(accounts) {
  const stateGroups = {};
  accounts.forEach((acc) => {
    const state = acc.BillingState || 'Unknown';
    if (!stateGroups[state]) stateGroups[state] = 0;
    stateGroups[state]++;
  });

  const topStates = Object.entries(stateGroups)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([state, count]) => '  ' + state + ': ' + count)
    .join('\n');

  const withCases = accounts.filter(a => a.Cases && a.Cases.records && a.Cases.records.length > 0).length;
  const critical = accounts.filter(a => a.Cases && a.Cases.records && a.Cases.records.length >= 3).length;

  return '*MWGL Queue Snapshot*\n\n' +
    '*Summary:*\n' +
    '  Total Districts: ' + accounts.length + '\n' +
    '  With Open Cases: ' + withCases + '\n' +
    '  Critical (3+ Cases): ' + critical + '\n\n' +
    '*Top States:*\n' + topStates + '\n\n' +
    'Updated: ' + new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' CST';
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  try {
    console.log('Starting MWGL Queue Snapshot Dashboard...');

    const docsDir = './docs';
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
    }

    console.log('Authenticating with Salesforce...');
    const accessToken = await authenticateWithSalesforce();
    console.log('Authentication successful');

    console.log('Querying MWGL accounts from Salesforce...');
    const result = await queryMWGLAccounts(accessToken);
    const accounts = result.records || [];
    console.log('Retrieved ' + accounts.length + ' districts');

    console.log('Archiving previous versions...');
    const archiveDir = archivePreviousVersions(docsDir);

    console.log('Generating dashboard...');
    const timestamp = new Date().toISOString().slice(0, 10);
    const templatePath = './dashboard-template.html';
    const indexPath = path.join(docsDir, 'index.html');
    const archivedPath = path.join(docsDir, 'index-' + timestamp + '.html');

    await generateDashboard(accounts, templatePath, indexPath);
    fs.copyFileSync(indexPath, archivedPath);
    console.log('Dashboard created: ' + indexPath);

    if (archiveDir) {
      createArchiveIndex(docsDir, archiveDir);
    }

    console.log('Copying to Google Drive...');
    copyToGoogleDrive(indexPath);

    console.log('Posting to Slack...');
    const slackChannel = process.env.SLACK_CHANNEL || '#daily-briefing';
    const dashboardUrl = process.env.DASHBOARD_URL || 'https://hirosuki.github.io/amira-automation/';
    const summary = formatSlackSummary(accounts);
    await postToSlack(slackChannel, summary, dashboardUrl);
    console.log('Slack notification sent');

    const metadata = {
      timestamp: new Date().toISOString(),
      totalDistricts: accounts.length,
      withOpenCases: accounts.filter(a => a.Cases && a.Cases.records && a.Cases.records.length > 0).length,
      criticalDistricts: accounts.filter(a => a.Cases && a.Cases.records && a.Cases.records.length >= 3).length,
      dashboardPath: indexPath,
      archivePath: archivedPath,
    };

    fs.writeFileSync(
      path.join(docsDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    console.log('\nMWGL Dashboard generated successfully!');
    console.log('Dashboard: ' + indexPath);
    console.log('View at: ' + dashboardUrl);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { authenticateWithSalesforce, queryMWGLAccounts, generateDashboard };
