/* =============================================
   CODEDROP — script.js
   ============================================= */

'use strict';

// ── CONFIG ─────────────────────────────────────
const DPASTE_API = 'https://dpaste.com/api/v2/';

const TEXT_EXTENSIONS = [
  '.html', '.css', '.js', '.ts', '.tsx', '.jsx',
  '.json', '.md',  '.txt', '.vue', '.svelte',
  '.yaml', '.yml', '.xml', '.svg', '.env',
  '.gitignore', '.sh', '.py', '.rb', '.go',
  '.rs',  '.php', '.java', '.c',  '.cpp',
  '.h',   '.cs',  '.kt',  '.swift', '.toml',
  '.lock', '.ini', '.conf', '.dockerfile',
  '.prettierrc', '.eslintrc', '.babelrc', '.npmrc',
  '.editorconfig',
];

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'];

// ── STATE ───────────────────────────────────────
let files      = {};   // { path: { type: 'text'|'image', content, mimeType? } }
let folders    = {};   // { "path/": true } — expanded state
let activeFile = null;

// ── UTILS ───────────────────────────────────────
function isTextFile(name) {
  const lower = name.toLowerCase();
  const noExtNames = ['.gitignore', '.env', 'dockerfile', '.editorconfig',
                      '.prettierrc', '.eslintrc', '.babelrc', '.npmrc'];
  if (noExtNames.some(n => lower.endsWith(n))) return true;
  return TEXT_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function isImageFile(name) {
  return IMAGE_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext));
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes) {
  if (bytes < 1024)      return bytes + ' B';
  if (bytes < 1024*1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024*1024)).toFixed(1) + ' MB';
}

function totalSize() {
  return Object.values(files).reduce((s, f) => {
    const c = (f && typeof f === 'object') ? f.content : f;
    return s + (c ? c.length : 0);
  }, 0);
}

// Normalise a file entry — old drops stored plain strings; new store { type, content }.
function normaliseFile(f) {
  if (!f || typeof f === 'string') return { type: 'text', content: f || '' };
  return f;
}

function fileExt(name) {
  const parts = name.split('.');
  return parts.length > 1 ? '.' + parts[parts.length - 1].toLowerCase() : '';
}

function fileIcon(name) {
  const ext = fileExt(name.split('/').pop());
  if (['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico'].includes(ext)) return '🖼️';
  const map = {
    '.html':'🌐','.css':'🎨','.js':'📜','.ts':'📘',
    '.tsx':'⚛️', '.jsx':'⚛️','.json':'📋','.md':'📝',
    '.txt':'📄', '.vue':'💚','.svelte':'🔥','.yaml':'⚙️',
    '.yml':'⚙️', '.xml':'📰','.svg':'🖼️','.env':'🔐',
    '.sh':'💻',  '.py':'🐍', '.rb':'💎', '.go':'🐹',
    '.rs':'🦀',  '.php':'🐘','.java':'☕','.c':'⚡',
    '.cpp':'⚡', '.cs':'🔷', '.kt':'🟣', '.swift':'🍎',
  };
  return map[ext] || '📄';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getLangFromPath(path) {
  const ext = fileExt(path.split('/').pop());
  const map = {
    '.js':'javascript','.ts':'typescript','.tsx':'tsx','.jsx':'jsx',
    '.html':'html','.css':'css','.json':'json','.md':'markdown',
    '.py':'python','.rb':'ruby','.go':'go','.rs':'rust',
    '.java':'java','.c':'c','.cpp':'cpp','.cs':'csharp',
    '.php':'php','.sh':'bash','.yaml':'yaml','.yml':'yaml',
    '.xml':'xml','.svg':'xml','.vue':'vue','.svelte':'svelte',
    '.txt':'',
  };
  return map[ext] || '';
}

// ── ROUTING ─────────────────────────────────────
function getRoute() {
  const path = window.location.pathname;
  console.log('[CodeDrop] pathname:', path);
  const match = path.match(/^\/v\/([a-zA-Z0-9_-]+)$/);
  if (match) {
    console.log('[CodeDrop] mode: view | id:', match[1]);
    return { mode: 'view', binId: match[1] };
  }
  console.log('[CodeDrop] mode: upload');
  return { mode: 'upload' };
}

// ── DPASTE API ───────────────────────────────────
async function saveToBin(data) {
  const compressed = LZString.compressToBase64(JSON.stringify(data));
  console.log('[CodeDrop] saveToBin — compressed length:', compressed.length);

  const formData = new URLSearchParams();
  formData.append('content', compressed);
  formData.append('syntax', 'text');
  formData.append('expiry_days', '365');

  let res;
  try {
    res = await fetch(DPASTE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });
    console.log('[CodeDrop] save direct status:', res.status);
  } catch (directErr) {
    console.warn('[CodeDrop] direct POST failed, trying proxy:', directErr.message);
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(DPASTE_API)}`;
    res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });
    console.log('[CodeDrop] proxy save status:', res.status);
  }

  if (!res.ok) throw new Error('Falha ao salvar: HTTP ' + res.status);

  const pasteUrl = await res.text();
  console.log('[CodeDrop] paste URL returned:', pasteUrl.trim());
  const pasteId  = pasteUrl.trim().replace(/\/$/, '').split('/').pop();
  console.log('[CodeDrop] extracted pasteId:', pasteId);
  return pasteId;
}

async function loadFromBin(pasteId) {
  console.log('[CodeDrop] loadFromBin → id:', pasteId);
  const directUrl = `https://dpaste.com/${pasteId}.txt`;
  const proxyUrl  = `https://corsproxy.io/?url=${encodeURIComponent(directUrl)}`;
  console.log('[CodeDrop] fetching via proxy:', proxyUrl);

  let compressed;
  try {
    const res = await fetch(proxyUrl);
    console.log('[CodeDrop] proxy response status:', res.status);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    compressed = await res.text();
  } catch (proxyErr) {
    console.warn('[CodeDrop] proxy failed, trying direct:', proxyErr.message);
    const res2 = await fetch(directUrl);
    console.log('[CodeDrop] direct response status:', res2.status);
    if (!res2.ok) throw new Error('Paste não encontrado: HTTP ' + res2.status);
    compressed = await res2.text();
  }

  console.log('[CodeDrop] raw data length:', compressed.length);
  const trimmed = compressed.trim();
  const decompressed = LZString.decompressFromBase64(trimmed);
  if (!decompressed) {
    console.error('[CodeDrop] decompression failed — raw snippet:', trimmed.slice(0, 120));
    throw new Error('Falha ao descomprimir: dados corrompidos ou formato inválido');
  }
  console.log('[CodeDrop] decompressed length:', decompressed.length);
  const parsed = JSON.parse(decompressed);
  console.log('[CodeDrop] files loaded:', Object.keys(parsed).length);
  return parsed;
}

// ── ZIP PROCESSING ──────────────────────────────
async function processZip(file) {
  const zip = await JSZip.loadAsync(file);
  const out  = {};
  const promises = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    const clean = relativePath.replace(/^__MACOSX\//, '').replace(/^\._/, '');
    if (!clean || clean.startsWith('.')) return;

    if (isTextFile(relativePath)) {
      promises.push(entry.async('string').then(content => {
        out[clean] = { type: 'text', content };
      }));
    } else if (isImageFile(relativePath)) {
      promises.push(entry.async('base64').then(b64 => {
        const ext  = fileExt(relativePath).replace('.', '');
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                   : ext === 'png'  ? 'image/png'
                   : ext === 'gif'  ? 'image/gif'
                   : ext === 'webp' ? 'image/webp'
                   : 'image/' + ext;
        out[clean] = { type: 'image', content: `data:${mime};base64,${b64}`, mimeType: mime };
      }));
    }
  });
  await Promise.all(promises);
  return out;
}

// ── FOLDER ENTRY PROCESSING ─────────────────────
async function processEntry(entry, basePath) {
  const out = {};
  if (entry.isFile) {
    const file = await new Promise(res => entry.file(res));
    const fullPath = basePath + entry.name;
    if (isTextFile(fullPath)) {
      out[fullPath] = { type: 'text', content: await file.text() };
    } else if (isImageFile(fullPath)) {
      out[fullPath] = { type: 'image', content: await readFileAsDataURL(file), mimeType: file.type };
    }
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let allEntries = [];
    await (async function readAll() {
      const batch = await new Promise(res => reader.readEntries(res));
      if (batch.length) {
        allEntries = allEntries.concat(Array.from(batch));
        await readAll();
      }
    })();
    for (const child of allEntries) {
      Object.assign(out, await processEntry(child, basePath + entry.name + '/'));
    }
  }
  return out;
}

// ── FILE HANDLING ───────────────────────────────
async function handleFiles(fileList) {
  const arr = Array.from(fileList);
  let added = 0;

  for (const file of arr) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      showToast('Descompactando ' + file.name + '…', 'info');
      try {
        const extracted = await processZip(file);
        Object.assign(files, extracted);
        added += Object.keys(extracted).length;
      } catch (e) {
        showToast('Erro ao extrair ZIP: ' + e.message, 'error');
      }
    } else if (isTextFile(file.name)) {
      files[file.name] = { type: 'text', content: await file.text() };
      added++;
    } else if (isImageFile(file.name)) {
      files[file.name] = { type: 'image', content: await readFileAsDataURL(file), mimeType: file.type };
      added++;
    }
  }

  if (added > 0) {
    showToast(added + ' arquivo(s) adicionado(s)', 'success');
    renderWorkspace();
  } else {
    showToast('Nenhum arquivo suportado encontrado', 'error');
  }
}

async function handleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');

  const items = e.dataTransfer.items;
  if (items && items.length > 0) {
    const entries = Array.from(items)
      .map(item => item.webkitGetAsEntry && item.webkitGetAsEntry())
      .filter(Boolean);

    if (entries.length > 0) {
      let added = 0;
      for (const entry of entries) {
        try {
          const result = await processEntry(entry, '');
          Object.assign(files, result);
          added += Object.keys(result).length;
        } catch (e2) { /* fallback */ }
      }
      if (added > 0) {
        showToast(added + ' arquivo(s) adicionado(s)', 'success');
        renderWorkspace();
        return;
      }
    }
  }

  if (e.dataTransfer.files.length) {
    await handleFiles(e.dataTransfer.files);
  }
}

// ── FILE TREE ────────────────────────────────────
function buildTree(fileMap) {
  const tree = {};
  Object.keys(fileMap).sort().forEach(path => {
    const parts = path.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      if (!node[dir]) node[dir] = { __isDir: true, __children: {} };
      node = node[dir].__children;
    }
    node[parts[parts.length - 1]] = { __isDir: false, __path: path };
  });
  return tree;
}

function renderTreeNode(node, prefix, depth) {
  let html = '';
  const keys = Object.keys(node).sort((a, b) => {
    if (node[a].__isDir && !node[b].__isDir) return -1;
    if (!node[a].__isDir && node[b].__isDir) return 1;
    return a.localeCompare(b);
  });

  for (const key of keys) {
    const item   = node[key];
    const indent = depth * 18;

    if (item.__isDir) {
      const folderPath = prefix + key + '/';
      const folderKey  = folderPath.replace(/\/$/, '');
      const isOpen     = folders[folderPath] !== false;
      html += `
        <div class="tree-item" data-folder="${escapeHtml(folderKey)}" onclick="toggleFolder(this,'${escapeHtml(folderPath)}')">
          <span class="tree-item-indent" style="width:${indent}px;display:inline-block"></span>
          <span class="tree-item-toggle ${isOpen ? 'open' : ''}">▶</span>
          <span class="tree-item-icon">📁</span>
          <span class="tree-item-name folder-name">${escapeHtml(key)}</span>
          <button class="tree-delete" onclick="deleteItem(event,'${escapeHtml(folderPath)}',true)" title="Deletar pasta">✕</button>
        </div>
        <div class="tree-subtree" data-subtree="${escapeHtml(folderPath)}" style="${isOpen ? '' : 'display:none'}">
          ${renderTreeNode(item.__children, folderPath, depth + 1)}
        </div>`;
    } else {
      const filePath = item.__path;
      const isActive = filePath === activeFile;
      html += `
        <div class="tree-item ${isActive ? 'active' : ''}" data-file="${escapeHtml(filePath)}" onclick="previewFile('${escapeHtml(filePath)}')">
          <span class="tree-item-indent" style="width:${indent + 14}px;display:inline-block"></span>
          <span class="tree-item-icon">${fileIcon(filePath)}</span>
          <span class="tree-item-name">${escapeHtml(key)}</span>
          <button class="tree-delete" onclick="deleteItem(event,'${escapeHtml(filePath)}',false)" title="Deletar arquivo">✕</button>
        </div>`;
    }
  }
  return html;
}

function toggleFolder(el, folderPath) {
  const toggle  = el.querySelector('.tree-item-toggle');
  const subtree = document.querySelector(`[data-subtree="${CSS.escape(folderPath)}"]`);
  if (!subtree) return;
  const isOpen = folders[folderPath] !== false;
  folders[folderPath] = !isOpen;
  subtree.style.display = folders[folderPath] ? '' : 'none';
  toggle.classList.toggle('open', folders[folderPath]);
}

function previewFile(path) {
  activeFile = path;
  document.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('active', el.dataset.file === path);
  });
  renderPreview();
}

function deleteItem(e, path, isFolder) {
  e.stopPropagation();
  if (isFolder) {
    Object.keys(files).forEach(f => { if (f.startsWith(path)) delete files[f]; });
    if (activeFile && activeFile.startsWith(path)) activeFile = null;
  } else {
    delete files[path];
    if (activeFile === path) activeFile = null;
  }
  renderWorkspace();
}

// ── TABS ─────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('tab-' + tab);
  if (btn) btn.classList.add('active');

  if (tab === 'text')  showAddTextModal();
  if (tab === 'image') showAddImageModal();
}

function resetTabs() {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const uploadBtn = document.getElementById('tab-upload');
  if (uploadBtn) uploadBtn.classList.add('active');
}

// ── ADD TEXT MODAL ───────────────────────────────
function showAddTextModal() {
  showModal(`
    <div class="modal-header">
      <span class="modal-title">✏️ Adicionar Texto</span>
      <button class="modal-close" onclick="closeModal();resetTabs()">✕</button>
    </div>
    <div class="modal-body">
      <div class="input-group">
        <label>Nome do arquivo</label>
        <input class="input-field" type="text" id="text-filename" placeholder="exemplo.txt" autocomplete="off" />
      </div>
      <div class="input-group" style="margin-top:14px;">
        <label>Conteúdo</label>
        <textarea class="input-field" id="text-content" rows="14"
          placeholder="Cole ou digite o código aqui..."
          style="resize:vertical;width:100%;"></textarea>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
        <button class="btn btn-secondary" onclick="closeModal();resetTabs()">Cancelar</button>
        <button class="btn btn-primary" onclick="addTextFile()">Adicionar</button>
      </div>
    </div>
  `);
  setTimeout(() => {
    const inp = document.getElementById('text-filename');
    if (inp) inp.focus();
  }, 50);
}

function addTextFile() {
  const filename = (document.getElementById('text-filename')?.value || '').trim();
  const content  =  document.getElementById('text-content')?.value || '';
  if (!filename) { showToast('Digite um nome para o arquivo', 'error'); return; }
  files[filename] = { type: 'text', content };
  closeModal();
  resetTabs();
  showToast('Arquivo "' + filename + '" adicionado!', 'success');
  renderWorkspace();
}

// ── ADD IMAGE MODAL ──────────────────────────────
function showAddImageModal() {
  showModal(`
    <div class="modal-header">
      <span class="modal-title">🖼️ Adicionar Imagem</span>
      <button class="modal-close" onclick="closeModal();resetTabs()">✕</button>
    </div>
    <div class="modal-body">
      <div class="image-drop-area" id="img-drop-area" onclick="document.getElementById('img-file-input').click()">
        <div style="font-size:40px;margin-bottom:12px;">🖼️</div>
        <div style="font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Arraste ou clique para selecionar</div>
        <div style="margin-top:8px;font-size:11px;color:var(--text-secondary);">png · jpg · gif · svg · webp</div>
        <input type="file" id="img-file-input" accept="image/*"
               style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;" />
      </div>
      <div id="img-preview-wrap" class="hidden" style="text-align:center;padding:16px;">
        <img id="img-preview-el" style="max-width:100%;max-height:180px;border:1px solid var(--border-hover);" />
        <div id="img-preview-name" style="margin-top:8px;font-size:12px;color:var(--text-secondary);"></div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
        <button class="btn btn-secondary" onclick="closeModal();resetTabs()">Cancelar</button>
        <button class="btn btn-primary" id="img-add-btn" disabled onclick="commitImage()">Adicionar</button>
      </div>
    </div>
  `);

  // State for selected image
  window._selectedImage = null;

  const dropArea  = document.getElementById('img-drop-area');
  const fileInput = document.getElementById('img-file-input');

  dropArea.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.add('dragover');
  });
  dropArea.addEventListener('dragleave', () => dropArea.classList.remove('dragover'));
  dropArea.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) handleImageSelect(file);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleImageSelect(e.target.files[0]);
  });
}

function handleImageSelect(file) {
  const reader = new FileReader();
  reader.onload = e => {
    window._selectedImage = { name: file.name, content: e.target.result, mimeType: file.type };

    const previewEl   = document.getElementById('img-preview-el');
    const previewWrap = document.getElementById('img-preview-wrap');
    const dropArea    = document.getElementById('img-drop-area');
    const addBtn      = document.getElementById('img-add-btn');
    const nameEl      = document.getElementById('img-preview-name');

    if (previewEl)   previewEl.src = e.target.result;
    if (nameEl)      nameEl.textContent = file.name;
    if (previewWrap) previewWrap.classList.remove('hidden');
    if (dropArea)    dropArea.classList.add('hidden');
    if (addBtn)      addBtn.disabled = false;
  };
  reader.readAsDataURL(file);
}

function commitImage() {
  const img = window._selectedImage;
  if (!img) return;
  const path = 'images/' + img.name;
  files[path] = { type: 'image', content: img.content, mimeType: img.mimeType };
  window._selectedImage = null;
  closeModal();
  resetTabs();
  showToast('Imagem "' + img.name + '" adicionada!', 'success');
  renderWorkspace();
}

// ── CREATE FOLDER ────────────────────────────────
function showCreateFolder() {
  showModal(`
    <div class="modal-header">
      <span class="modal-title">📁 Nova Pasta</span>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--text-secondary);margin-bottom:16px;font-size:12px;letter-spacing:0.5px;">
        Digite o caminho da pasta (ex: <span style="color:var(--accent);">src/components</span>)
      </p>
      <input class="input-field" id="folder-name-input" placeholder="src/components" autocomplete="off" />
      <div style="margin-top:16px;display:flex;gap:10px;">
        <button class="btn btn-primary w-full" onclick="createFolder()">Criar Pasta</button>
        <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      </div>
    </div>
  `);
  setTimeout(() => {
    const inp = document.getElementById('folder-name-input');
    if (inp) {
      inp.focus();
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') createFolder(); });
    }
  }, 50);
}

function createFolder() {
  const inp = document.getElementById('folder-name-input');
  if (!inp) return;
  const name = inp.value.trim().replace(/^\/|\/$/g, '');
  if (!name) { showToast('Digite um nome para a pasta', 'error'); return; }
  files[name + '/.gitkeep'] = { type: 'text', content: '' };
  closeModal();
  showToast('Pasta "' + name + '" criada', 'success');
  renderWorkspace();
}

// ── RENDER WORKSPACE ────────────────────────────
function renderWorkspace() {
  // renderUploadMode now handles everything including the workspace
  renderUploadMode();
}

function renderPreviewHTML() {
  if (!activeFile || !files[activeFile]) {
    return `
      <div class="preview-empty">
        <div class="preview-empty-icon">👈</div>
        <div class="preview-empty-text text-muted">Clique em um arquivo para visualizar</div>
      </div>`;
  }
  const f = normaliseFile(files[activeFile]);
  const header = `
    <div class="preview-header">
      <span class="preview-filename">${escapeHtml(activeFile)}</span>
      <button class="btn btn-ghost btn-sm" onclick="activeFile=null;renderPreview()">✕ Fechar</button>
    </div>`;
  if (f.type === 'image') {
    return header + `<div class="preview-image-wrap"><img src="${f.content}" alt="${escapeHtml(activeFile)}" /></div>`;
  }
  return header + `<pre class="code-block">${escapeHtml(f.content)}</pre>`;
}

function renderPreview() {
  const panel = document.getElementById('preview-panel');
  if (panel) panel.innerHTML = renderPreviewHTML();
}

function clearAll() {
  if (!confirm('Limpar todos os arquivos?')) return;
  files = {};
  activeFile = null;
  renderUploadMode();
}

// ── UPLOAD MODE ──────────────────────────────────
function renderUploadMode() {
  activeFile = null;
  const app = document.getElementById('app');
  const count = Object.keys(files).length;
  const size  = formatSize(totalSize());

  const treeHtml = count > 0
    ? renderTreeNode(buildTree(files), '', 0)
    : `<div class="tree-empty">Nenhum arquivo ainda.<br>Use as opções acima para adicionar.</div>`;

  app.innerHTML = `
    <div class="upload-mode">
      <div class="upload-mode-header">
        <h1>Compartilhe seu Código</h1>
        <p>Faça upload de arquivos, pastas ou .zip e gere um link curto para compartilhar</p>
      </div>

      <!-- Input Tabs — ALWAYS VISIBLE -->
      <div class="input-tabs">
        <button class="tab-btn active" id="tab-upload" onclick="switchTab('upload')">📂 Upload Arquivos</button>
        <button class="tab-btn" id="tab-text"   onclick="switchTab('text')">✏️ Escrever Texto</button>
        <button class="tab-btn" id="tab-image"  onclick="switchTab('image')">🖼️ Adicionar Imagem</button>
      </div>

      <!-- Upload Area -->
      <div class="upload-area" id="upload-area">
        <input type="file" id="file-input" multiple accept="*" />
        <div class="upload-icon">📂</div>
        <div class="upload-title">Arraste arquivos ou .zip aqui</div>
        <div class="upload-sub">ou clique para selecionar</div>
        <div class="upload-exts">
          ${['html','css','js','ts','tsx','jsx','json','md','txt','vue','svelte','yaml','py','go','rs'].map(e =>
            `<span class="ext-badge">.${e}</span>`).join('')}
          <span class="ext-badge">+ imagens</span>
          <span class="ext-badge">+ mais</span>
        </div>
      </div>

      <!-- File Manager — always visible -->
      <div class="panel" style="margin-bottom:16px;">
        <div class="panel-header">
          <span class="panel-title">Arquivos (${count})</span>
          <button class="btn btn-ghost btn-sm" onclick="showCreateFolder()">+ Pasta</button>
        </div>
        <div class="panel-body">
          <div class="file-tree" id="file-tree">${treeHtml}</div>
        </div>
        ${count > 0 ? `
        <div class="panel-footer">
          <span class="panel-footer-info">${count} arquivo(s) · ${size}</span>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-danger btn-sm" onclick="clearAll()">Limpar tudo</button>
            <button class="btn btn-primary btn-sm" onclick="generateLink()" id="gen-btn">⚡ Gerar Link</button>
          </div>
        </div>` : ''}
      </div>

      ${count > 0 ? `
      <!-- Preview Panel -->
      <div class="panel preview-panel" id="preview-panel">
        ${renderPreviewHTML()}
      </div>
      ` : ''}
    </div>
  `;

  attachUploadEvents();
  if (count > 0) setupTreeDragAndDrop();
}

function attachUploadEvents() {
  const area  = document.getElementById('upload-area');
  const input = document.getElementById('file-input');
  if (!area || !input) return;

  area.addEventListener('dragover', e => {
    e.preventDefault();
    area.classList.add('dragover');
  });
  area.addEventListener('dragleave', e => {
    if (!area.contains(e.relatedTarget)) area.classList.remove('dragover');
  });
  area.addEventListener('drop', handleDrop);
  input.addEventListener('change', e => {
    if (e.target.files.length) handleFiles(e.target.files);
    input.value = '';
  });
}

// ── GENERATE LINK ────────────────────────────────
async function generateLink() {
  const btn   = document.getElementById('gen-btn');
  const count = Object.keys(files).length;
  if (count === 0) { showToast('Adicione arquivos primeiro', 'error'); return; }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvando…'; }

  try {
    const binId = await saveToBin(files);
    const link  = window.location.origin + '/v/' + binId;
    showLinkModal(link, count, formatSize(totalSize()));
    showToast('Link gerado com sucesso!', 'success');
  } catch (err) {
    showToast('Erro ao gerar link: ' + err.message, 'error');
  }

  if (btn) { btn.disabled = false; btn.innerHTML = '⚡ Gerar Link'; }
}

function showLinkModal(link, count, size) {
  showModal(`
    <div class="modal-header">
      <span class="modal-title">✅ Link Gerado</span>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="link-display">${escapeHtml(link)}</div>
      <div class="modal-actions">
        <button class="btn btn-primary w-full btn-lg" onclick="copyLink('${escapeHtml(link)}')">
          📋 Copiar Link
        </button>
        <a href="${escapeHtml(link)}" target="_blank" class="btn btn-secondary w-full" style="justify-content:center;">
          🔗 Abrir Link
        </a>
      </div>
      <div class="modal-meta">${count} arquivo(s) · ${size}</div>
    </div>
  `);
}

function copyLink(link) {
  navigator.clipboard.writeText(link).then(() => showToast('Link copiado!', 'success'));
}

// ── VIEW MODE ────────────────────────────────────
async function renderViewMode(binId) {
  console.log('[CodeDrop] renderViewMode → binId:', binId);

  const app    = document.getElementById('app');
  const header = document.getElementById('header-actions');

  if (!app) { console.error('[CodeDrop] #app not found!'); return; }

  if (header) {
    header.innerHTML = `<a href="/" class="btn btn-secondary">+ Criar novo drop</a>`;
  }

  app.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <div class="loading-text">Carregando arquivos…</div>
    </div>`;

  try {
    console.log('[CodeDrop] calling loadFromBin…');
    const data = await loadFromBin(binId);
    console.log('[CodeDrop] data received:', data);

    if (!data || typeof data !== 'object') throw new Error('Dados inválidos recebidos');

    files = data;
    const count  = Object.keys(files).length;
    const size   = formatSize(totalSize());
    const sorted = Object.keys(files).sort();

    let blocksHtml = '';
    for (const path of sorted) {
      const f    = normaliseFile(files[path]);
      const icon = f.type === 'image' ? '🖼️' : fileIcon(path);
      const body = f.type === 'image'
        ? `<div class="view-file-image"><img src="${f.content}" alt="${escapeHtml(path)}" /></div>`
        : `<pre class="code-block">${escapeHtml(f.content || '')}</pre>`;

      blocksHtml += `
        <div class="file-block">
          <div class="file-block-header">
            <span style="color:var(--text-muted);font-size:11px;">═══</span>
            <span class="file-block-name">${icon} ${escapeHtml(path)}</span>
            <div class="file-block-separator"></div>
            ${f.type !== 'image' ? `<button class="file-block-copy" onclick="copyFileContent('${escapeHtml(path)}')">📋 Copiar</button>` : ''}
          </div>
          ${body}
        </div>`;
    }

    app.innerHTML = `
      <div class="view-mode">
        <div class="view-header">
          <div class="view-meta">
            <span class="view-meta-info">${count} arquivo(s) · ${size}</span>
            <span class="view-meta-info text-muted">ID: ${escapeHtml(binId)}</span>
          </div>
          <div class="view-actions">
            <button class="btn btn-secondary" onclick="copyAllText()">📄 Copiar Texto</button>
            <button class="btn btn-secondary" onclick="copyAllMarkdown()">📝 Copiar Markdown</button>
            <button class="btn btn-primary"   onclick="downloadAsPDF()">⬇ Baixar PDF</button>
          </div>
        </div>
        <div class="file-blocks">${blocksHtml}</div>
      </div>`;

  } catch (err) {
    console.error('[CodeDrop] renderViewMode error:', err);
    app.innerHTML = `
      <div class="error-state">
        <div class="error-icon">💀</div>
        <div class="error-title">Drop não encontrado</div>
        <div class="error-msg">${escapeHtml(err.message)}</div>
        <div class="error-msg" style="margin-top:6px;font-size:10px;color:var(--text-muted);">ID: ${escapeHtml(binId)}</div>
        <a href="/" class="btn btn-primary" style="margin-top:20px;">← Criar novo drop</a>
      </div>`;
  }
}

// ── COPY FUNCTIONS ───────────────────────────────
function copyFileContent(path) {
  const f = normaliseFile(files[path]);
  if (f.type === 'image') { showToast('Imagens não podem ser copiadas como texto', 'error'); return; }
  navigator.clipboard.writeText(f.content || '').then(() => {
    showToast('Conteúdo copiado!', 'success');
  });
}

function copyAllText() {
  const sorted = Object.keys(files).sort();
  const parts  = sorted
    .filter(path => normaliseFile(files[path]).type !== 'image')
    .map(path => `=== ${path} ===\n${normaliseFile(files[path]).content}`);
  navigator.clipboard.writeText(parts.join('\n\n')).then(() => {
    showToast('Arquivos copiados como texto!', 'success');
  });
}

function copyAllMarkdown() {
  const sorted = Object.keys(files).sort();
  const parts  = sorted
    .filter(path => normaliseFile(files[path]).type !== 'image')
    .map(path => {
      const lang = getLangFromPath(path);
      return `# ${path}\n\`\`\`${lang}\n${normaliseFile(files[path]).content}\n\`\`\``;
    });
  navigator.clipboard.writeText(parts.join('\n\n')).then(() => {
    showToast('Arquivos copiados como Markdown!', 'success');
  });
}

// ── DOWNLOAD PDF ─────────────────────────────────
async function downloadAsPDF() {
  if (!window.jspdf) { showToast('Biblioteca PDF não carregada', 'error'); return; }
  showToast('Gerando PDF…', 'info');

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const pageW  = doc.internal.pageSize.getWidth();
  const pageH  = doc.internal.pageSize.getHeight();
  const margin = 15;
  const maxW   = pageW - margin * 2;
  let y = margin;

  function checkPage(needed = 10) {
    if (y + needed > pageH - margin) { doc.addPage(); y = margin; }
  }

  // Title
  doc.setFontSize(20);
  doc.setFont('courier', 'bold');
  doc.setTextColor(153, 69, 255);
  doc.text('CODEDROP EXPORT', margin, y); y += 8;

  // Date
  doc.setFontSize(9);
  doc.setFont('courier', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text('Exportado em: ' + new Date().toLocaleString('pt-BR'), margin, y); y += 5;

  const sorted = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  doc.text(sorted.length + ' arquivo(s)', margin, y); y += 10;

  // Separator
  doc.setDrawColor(153, 69, 255);
  doc.setLineWidth(0.4);
  doc.line(margin, y, pageW - margin, y); y += 8;

  for (const [path, rawFile] of sorted) {
    const f = normaliseFile(rawFile);
    checkPage(20);

    // File header
    doc.setFontSize(11);
    doc.setFont('courier', 'bold');
    doc.setTextColor(153, 69, 255);
    doc.text('=== ' + path + ' ===', margin, y); y += 6;
    doc.setTextColor(30, 30, 30);

    if (f.type === 'image') {
      try {
        let fmt = 'JPEG';
        if (f.mimeType === 'image/png')  fmt = 'PNG';
        if (f.mimeType === 'image/gif')  fmt = 'GIF';
        if (f.mimeType === 'image/webp') fmt = 'WEBP';

        const imgProps = doc.getImageProperties(f.content);
        const ratio    = imgProps.width / imgProps.height;
        const imgW     = Math.min(maxW, 100);
        const imgH     = imgW / ratio;

        checkPage(imgH + 6);
        doc.addImage(f.content, fmt, margin, y, imgW, imgH);
        y += imgH + 8;
      } catch (imgErr) {
        console.warn('[PDF] image failed:', imgErr);
        doc.setFontSize(9);
        doc.setFont('courier', 'italic');
        doc.setTextColor(150, 50, 50);
        doc.text('[Imagem não pôde ser renderizada]', margin, y); y += 7;
      }
    } else {
      doc.setFontSize(8);
      doc.setFont('courier', 'normal');
      doc.setTextColor(40, 40, 40);
      const rawLines = (f.content || '').split('\n');
      for (const rawLine of rawLines) {
        const wrapped = doc.splitTextToSize(rawLine || ' ', maxW);
        for (const wl of wrapped) {
          checkPage(4);
          doc.text(wl, margin, y); y += 4;
        }
      }
      y += 6;
    }

    // Separator between files
    checkPage(4);
    doc.setDrawColor(60, 60, 60);
    doc.setLineWidth(0.1);
    doc.line(margin, y, pageW - margin, y); y += 6;
  }

  doc.save('codedrop-export.pdf');
  showToast('PDF baixado com sucesso!', 'success');
}

// ── MODAL ────────────────────────────────────────
function showModal(html) {
  const overlay = document.getElementById('modal-overlay');
  const box     = document.getElementById('modal-box');
  box.innerHTML = html;
  overlay.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ── TOAST ────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = 'toast ' + (type === 'success' ? 'success' : type === 'error' ? 'error' : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ── TREE DRAG AND DROP ───────────────────────────
function setupTreeDragAndDrop() {
  const tree = document.getElementById('file-tree');
  if (!tree) return;

  // Make all tree items draggable
  tree.querySelectorAll('.tree-item').forEach(item => {
    const path = item.dataset.file || item.dataset.folder;
    if (!path) return;
    item.setAttribute('draggable', 'true');
    item.style.cursor = 'grab';

    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', path);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
  });

  // Folder items accept drops
  tree.querySelectorAll('[data-folder]').forEach(folder => {
    const folderPath = folder.dataset.folder.replace(/\/$/, '');

    folder.addEventListener('dragover', e => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      folder.classList.add('drag-over');
    });
    folder.addEventListener('dragleave', e => {
      if (!folder.contains(e.relatedTarget)) folder.classList.remove('drag-over');
    });
    folder.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      folder.classList.remove('drag-over');
      const sourcePath = e.dataTransfer.getData('text/plain');
      if (!sourcePath) return;
      // Prevent moving folder into itself
      if (sourcePath === folderPath || folderPath.startsWith(sourcePath + '/')) {
        showToast('Não é possível mover pasta para dentro de si mesma', 'error');
        return;
      }
      moveFile(sourcePath, folderPath);
    });
  });

  // Root tree area accepts drops (move to root)
  tree.addEventListener('dragover', e => {
    if (e.target === tree) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tree.classList.add('drag-over');
    }
  });
  tree.addEventListener('dragleave', e => {
    if (e.target === tree) tree.classList.remove('drag-over');
  });
  tree.addEventListener('drop', e => {
    if (e.target !== tree) return;
    e.preventDefault();
    tree.classList.remove('drag-over');
    const sourcePath = e.dataTransfer.getData('text/plain');
    if (sourcePath) moveFileToRoot(sourcePath);
  });
}

function moveFile(sourcePath, targetFolder) {
  const isSourceFolder = !files[sourcePath]; // it's a folder if not a direct file key
  const sourceIsFolder = sourcePath.endsWith('/') || Object.keys(files).some(k => k.startsWith(sourcePath + '/'));

  const fileName = sourcePath.split('/').pop();
  const newPath  = targetFolder ? `${targetFolder}/${fileName}` : fileName;

  if (newPath === sourcePath) return;

  // Check conflict
  if (files[newPath]) {
    showToast('Já existe um arquivo com esse nome nessa pasta', 'error');
    return;
  }

  if (files[sourcePath]) {
    // It's a file
    files[newPath] = files[sourcePath];
    delete files[sourcePath];
    if (activeFile === sourcePath) activeFile = newPath;
  } else {
    // It's a folder — move all children
    const prefix    = sourcePath + '/';
    const newPrefix = newPath + '/';
    const toMove    = Object.keys(files).filter(k => k.startsWith(prefix));
    if (toMove.length === 0) { showToast('Pasta vazia ou não encontrada', 'error'); return; }
    toMove.forEach(oldKey => {
      const rel    = oldKey.slice(prefix.length);
      const newKey = newPrefix + rel;
      files[newKey] = files[oldKey];
      delete files[oldKey];
      if (activeFile === oldKey) activeFile = newKey;
    });
  }

  showToast('Movido para ' + (targetFolder || 'raiz'), 'success');
  renderUploadMode();
}

function moveFileToRoot(sourcePath) {
  const fileName = sourcePath.split('/').pop();
  if (!sourcePath.includes('/')) return; // already at root
  moveFile(sourcePath, '');
}

// ── INIT ─────────────────────────────────────────
function init() {
  console.log('[CodeDrop] init() called');
  const route = getRoute();
  console.log('[CodeDrop] route:', route);

  if (route.mode === 'view' && route.binId) {
    console.log('[CodeDrop] → view mode');
    renderViewMode(route.binId);
  } else {
    console.log('[CodeDrop] → upload mode');
    renderUploadMode();
  }
}

window.addEventListener('popstate', init);

document.addEventListener('DOMContentLoaded', () => {
  console.log('[CodeDrop] DOMContentLoaded fired');

  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  init();
});
