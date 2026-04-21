#!/usr/bin/env node
/**
 * ステップ1: ローカル対象ファイルを列挙し、git blob SHA を計算、
 *           GitHub 側 tree と差分比較して変更ファイルリストを /tmp/rebuild_push_diff.json に保存する。
 * 期待所要時間: ~5-10秒
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { githubAPI } = require('../git-push.js');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'kariumu', REPO = 'gcg-meta', BRANCH = 'main';
const OUT = '/tmp/rebuild_push_diff.json';

function gitBlobSha(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  const h = crypto.createHash('sha1');
  h.update('blob ' + buf.length + '\0');
  h.update(buf);
  return h.digest('hex');
}

function listLocalTargets() {
  const files = [];
  for (const name of fs.readdirSync(path.join(ROOT, 'events'))) {
    if (name.endsWith('.html')) files.push({ p: 'events/' + name, l: path.join(ROOT, 'events', name) });
  }
  const cardsDir = path.join(ROOT, 'cards');
  for (const name of fs.readdirSync(cardsDir)) {
    const sub = path.join(cardsDir, name);
    if (fs.statSync(sub).isDirectory()) {
      const idx = path.join(sub, 'index.html');
      if (fs.existsSync(idx)) files.push({ p: 'cards/' + name + '/index.html', l: idx });
    }
  }
  for (const name of ['index.html', 'events.html', 'meta.html', 'cards.html', 'sitemap.xml']) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) files.push({ p: name, l: p });
  }
  return files;
}

(async () => {
  const t0 = Date.now();
  const local = listLocalTargets();
  console.log('local:', local.length);

  const ref = await githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  const c = await githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + ref.object.sha);
  console.log('HEAD:', ref.object.sha.substring(0,7), 'tree:', c.tree.sha.substring(0,7));

  const tree = await githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/trees/' + c.tree.sha + '?recursive=1');
  const remote = {};
  for (const it of (tree.tree || [])) if (it.type === 'blob') remote[it.path] = it.sha;
  console.log('remote files:', Object.keys(remote).length, 'truncated:', !!tree.truncated);

  const added = [], changed = [], unchanged = [];
  for (const f of local) {
    const content = fs.readFileSync(f.l, 'utf-8');
    const sha = gitBlobSha(content);
    if (!remote[f.p]) added.push(f.p);
    else if (remote[f.p] !== sha) changed.push(f.p);
    else unchanged.push(f.p);
  }
  console.log('added=' + added.length + ', changed=' + changed.length + ', unchanged=' + unchanged.length);
  console.log('elapsed:', ((Date.now()-t0)/1000).toFixed(1), 's');

  const toPush = added.concat(changed);
  fs.writeFileSync(OUT, JSON.stringify({ headSha: ref.object.sha, toPush, added: added.length, changed: changed.length }, null, 0));
  console.log('saved:', OUT, '/ push対象:', toPush.length);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
