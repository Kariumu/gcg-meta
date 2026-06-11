// git-push.js
// GitHub REST API経由でファイルをコミット・pushする共通モジュール
//
// 使い方:
//   const { pushFiles } = require('./git-push');
//   await pushFiles([
//     { path: 'reports/news/2026-04-03.html', content: htmlString },
//     { path: 'data/summary.json', content: jsonString }
//   ], 'Update news article 2026-04-03');

const https = require('https');
const fs = require('fs');
const path = require('path');

// 設定
const OWNER = 'kariumu';
const REPO = 'gcg-meta';
const BRANCH = 'main';

function getToken() {
  // 1. 環境変数から取得
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  // 2. .envファイルから取得
  const envPaths = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env')
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const match = content.match(/GITHUB_TOKEN=(.+)/);
      if (match) return match[1].trim();
    }
  }

  throw new Error('GITHUB_TOKEN not found. Set it as environment variable or in .env file.');
}

function githubAPI(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const options = {
      hostname: 'api.github.com',
      path: endpoint,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'gcg-meta-bot',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${parsed.message || data}`));
          } else {
            resolve(parsed);
          }
        } catch(e) {
          reject(new Error(`GitHub API parse error: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * 複数ファイルを1つのコミットでpushする
 * @param {Array<{path: string, content: string}>} files - pushするファイル
 * @param {string} message - コミットメッセージ
 */
async function pushFiles(files, message) {
  if (!files || files.length === 0) {
    console.log('[git-push] No files to push');
    return;
  }

  console.log(`[git-push] Pushing ${files.length} file(s) to ${OWNER}/${REPO}...`);

  try {
    // 1. 現在のブランチのHEADコミットを取得
    const ref = await githubAPI('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    const latestCommitSha = ref.object.sha;

    // 2. 最新コミットのtreeを取得
    const commit = await githubAPI('GET', `/repos/${OWNER}/${REPO}/git/commits/${latestCommitSha}`);
    const baseTreeSha = commit.tree.sha;

    // 3. 各ファイルのblobを作成
    const treeItems = [];
    for (const file of files) {
      const blob = await githubAPI('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
        content: Buffer.from(file.content, 'utf-8').toString('base64'),
        encoding: 'base64'
      });
      treeItems.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha
      });
      console.log(`  [blob] ${file.path}`);
    }

    // 4. 新しいtreeを作成
    const newTree = await githubAPI('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
      base_tree: baseTreeSha,
      tree: treeItems
    });

    // 5. 新しいコミットを作成
    const newCommit = await githubAPI('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
      message: message,
      tree: newTree.sha,
      parents: [latestCommitSha]
    });

    // 6. ブランチの参照を更新（push）
    await githubAPI('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      sha: newCommit.sha
    });

    console.log(`[git-push] Success: ${newCommit.sha.substring(0, 7)} "${message}"`);
    return newCommit;

  } catch (error) {
    console.error(`[git-push] Error: ${error.message}`);
    throw error;
  }
}

/**
 * ローカルファイルを読み込んでpushする
 * @param {Array<{localPath: string, repoPath: string}>} files - ローカルパスとリポジトリパス
 * @param {string} message - コミットメッセージ
 */
async function pushLocalFiles(files, message) {
  const fileContents = files.map(f => ({
    path: f.repoPath,
    content: fs.readFileSync(f.localPath, 'utf-8')
  }));
  return pushFiles(fileContents, message);
}

/**
 * バイナリファイルをpushする（画像等）
 * @param {string} repoPath - リポジトリ内のパス
 * @param {string} localPath - ローカルファイルパス
 * @param {string} message - コミットメッセージ
 */
async function pushBinaryFile(repoPath, localPath, message) {
  const content = fs.readFileSync(localPath).toString('base64');

  // 既存ファイルのSHAを取得（上書きの場合に必要）
  let sha = null;
  try {
    const existing = await githubAPI('GET', `/repos/${OWNER}/${REPO}/contents/${repoPath}?ref=${BRANCH}`);
    sha = existing.sha;
  } catch(e) {
    // ファイルが存在しない場合は新規作成
  }

  const body = {
    message: message,
    content: content,
    branch: BRANCH
  };
  if (sha) body.sha = sha;

  return githubAPI('PUT', `/repos/${OWNER}/${REPO}/contents/${repoPath}`, body);
}

module.exports = { pushFiles, pushLocalFiles, pushBinaryFile, githubAPI };
