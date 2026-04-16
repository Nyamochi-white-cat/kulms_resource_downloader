// 定期的にDOMを監視して「ダウンロード」ボタンを追加する処理
function initObserver() {
  const observer = new MutationObserver(() => {
    addDownloadButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // 初回実行
  addDownloadButton();
}

function addDownloadButton() {
  const links = document.querySelectorAll('a');
  for (const link of links) {
    if (link.textContent.includes('プロパティを表示') && !link.dataset.downloadAdded) {
      link.dataset.downloadAdded = 'true';
      const li = link.closest('li');
      if (li) {
        const downloadLi = document.createElement('li');
        downloadLi.className = li.className;
        downloadLi.setAttribute("role", "presentation");

        const downloadLink = document.createElement('a');
        downloadLink.href = '#';
        downloadLink.className = link.className;
        downloadLink.textContent = 'ダウンロード';
        downloadLink.setAttribute("role", "menuitem");

        downloadLink.addEventListener('click', async (e) => {
          e.preventDefault();
          // 要素が存在する行 (tr) と、起点となった「プロパティ」リンクを渡す
          await processDownloadForRow(link.closest('tr'), link, e.target);
        });

        downloadLi.appendChild(downloadLink);
        li.parentNode.insertBefore(downloadLi, link.closest('li').nextSibling);
      }
    }
  }
}

async function processDownloadForRow(tr, propLink, btnElement) {
  if (!tr) {
    alert('テーブルの行が見つかりませんでした。');
    return;
  }

  const originalText = btnElement.textContent;
  try {
    let downloadUrl = null;
    let isFolder = false;

    // 1. 直リンクの検索
    const accessLink = Array.from(tr.querySelectorAll('a')).find(a => a.href && a.href.includes('/access/content/'));
    if (accessLink) {
      downloadUrl = accessLink.href;
    }

    // 2. チェックボックスのvalue
    if (!downloadUrl) {
      const checkbox = tr.querySelector('input[type="checkbox"]');
      if (checkbox && checkbox.value) {
        let val = checkbox.value;
        if (val.includes('/group/') || val.includes('/user/') || val.includes('/attachment/')) {
          if (!val.startsWith('/')) val = '/' + val;
          downloadUrl = window.location.origin + '/access/content' + val;
        }
      }
    }

    // 3. プロパティリンクの href 内の itemId パラメータ
    if (!downloadUrl && propLink.href && propLink.href.includes('itemId=')) {
      try {
        const urlObj = new URL(propLink.href);
        const itemIdStr = urlObj.searchParams.get('itemId');
        if (itemIdStr) {
          const itemId = decodeURIComponent(itemIdStr);
          if (itemId.startsWith('/')) {
            downloadUrl = window.location.origin + '/access/content' + itemId;
          }
        }
      } catch (e) { }
    }

    // 4. プロパティリンクのonclick属性の中身
    if (!downloadUrl) {
      let onclickStr = propLink.getAttribute('onclick') || '';
      const match = onclickStr.match(/['"](\/group\/[^'"]+|\/user\/[^'"]+|\/attachment\/[^'"]+)['"]/);
      if (match) {
        downloadUrl = window.location.origin + '/access/content' + match[1];
      }
    }

    if (!downloadUrl) {
      alert('このアイテムのダウンロードURLを特定できませんでした。');
      resetButton(btnElement, originalText);
      return;
    }

    // URLのエンコード処理（日本語名のファイル/フォルダ対応）
    const urlParts = downloadUrl.split('/');
    const encodedDownloadUrl = urlParts.map(p => {
      try { return encodeURIComponent(decodeURIComponent(p)); }
      catch (e) { return encodeURIComponent(p); }
    }).join('/').replace(/%3A/g, ':');

    // フォルダかどうかの判定
    if (downloadUrl.endsWith('/')) {
      isFolder = true;
    } else if (tr.querySelector('.fa-folder, .fa-folder-open, [src*="folder"]')) {
      isFolder = true;
    }

    const finalUrl = isFolder && !encodedDownloadUrl.endsWith('/') ? encodedDownloadUrl + '/' : encodedDownloadUrl;

    if (!isFolder) {
      // ===== 単一ファイルのダウンロード =====
      const fileName = getFilenameFromUrl(finalUrl);
      const fileList = [{ url: finalUrl, displayPath: fileName }];

      showSelectionModal({
        fileList: fileList,
        defaultName: fileName,
        isFolder: false,
        onConfirm: async (selectedUrls, downloadSettings) => {
          if (selectedUrls.length === 0) {
            resetButton(btnElement, originalText);
            return;
          }
          try {
            if (downloadSettings.mode === 'default') {
              btnElement.textContent = 'DL登録中...';
              chrome.runtime.sendMessage({
                type: 'DOWNLOAD_FILE',
                url: finalUrl,
                filename: fileName
              });
              btnElement.textContent = '完了';
              setTimeout(() => resetButton(btnElement, originalText), 1500);
            } else if (downloadSettings.mode === 'custom') {
              btnElement.textContent = 'DL中...';
              const fileRes = await fetch(finalUrl);
              if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
              const blob = await fileRes.blob();

              btnElement.textContent = '書込中...';
              const writable = await downloadSettings.handle.createWritable();
              await writable.write(blob);
              await writable.close();
              btnElement.textContent = '完了';
              setTimeout(() => resetButton(btnElement, originalText), 1500);
            }
          } catch (e) {
            resetButton(btnElement, originalText);
          }
        },
        onCancel: () => resetButton(btnElement, originalText)
      });
    } else {
      // ===== フォルダ階層のダウンロード =====
      btnElement.textContent = 'リスト取得中...';
      btnElement.style.pointerEvents = 'none';
      const fileList = [];
      await fetchFolderList(finalUrl, fileList, finalUrl);

      if (fileList.length === 0) {
        alert('フォルダが空、または読み取りに失敗しました。');
        resetButton(btnElement, originalText);
        return;
      }

      const targetFolderName = decodeURIComponent(finalUrl.split('/').filter(Boolean).pop());

      showSelectionModal({
        fileList: fileList,
        defaultName: targetFolderName,
        isFolder: true,
        onConfirm: async (selectedFiles, downloadSettings) => {
          if (selectedFiles.length === 0) {
            alert('ファイルが選択されていません。');
            resetButton(btnElement, originalText);
            return;
          }

          try {
            // [A] デフォルトモード (chrome.downloads でそのまま保存、またはZIP化)
            if (downloadSettings.mode === 'default') {
              if (downloadSettings.format === 'raw') {
                btnElement.textContent = '開始中...';
                let currentCount = 0;
                for (const fileUrl of selectedFiles) {
                  const relativePath = decodeURIComponent(fileUrl.substring(finalUrl.length));
                  // 先頭のスラッシュ調整
                  const cleanRelativePath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
                  const targetFilePath = targetFolderName + '/' + cleanRelativePath;

                  chrome.runtime.sendMessage({
                    type: 'DOWNLOAD_FILE',
                    url: fileUrl,
                    filename: targetFilePath
                  });
                  currentCount++;
                  btnElement.textContent = `登録中 (${currentCount}/${selectedFiles.length})`;
                }
                btnElement.textContent = '登録完了!';
                setTimeout(() => resetButton(btnElement, originalText), 2500);
              } else {
                // ZIP Mode default
                btnElement.textContent = 'ZIP構築中...';
                const zip = new JSZip();
                let currentCount = 0;

                for (const fileUrl of selectedFiles) {
                  try {
                    const relativePath = decodeURIComponent(fileUrl.substring(finalUrl.length));
                    const fileRes = await fetch(fileUrl);
                    if (fileRes.ok) {
                      const blob = await fileRes.blob();
                      zip.file(relativePath, blob);
                      currentCount++;
                      btnElement.textContent = `ZIP構築中 (${currentCount}/${selectedFiles.length})`;
                    }
                  } catch (e) { }
                }

                btnElement.textContent = 'ZIP生成中...';
                const zipBlob = await zip.generateAsync({ type: 'blob' });
                triggerBlobDownload(zipBlob, targetFolderName + '.zip');

                btnElement.textContent = '完了';
                setTimeout(() => resetButton(btnElement, originalText), 1500);
              }
            }
            // [B] カスタムモード (保存先が指定されている)
            else if (downloadSettings.mode === 'custom') {
              if (downloadSettings.format === 'raw') {
                // フォルダ展開形式での保存
                btnElement.textContent = '実行中...';
                const dirHandle = downloadSettings.handle;

                // 対象のフォルダ自身を作成
                const baseFolderHandle = await dirHandle.getDirectoryHandle(targetFolderName, { create: true });

                let currentCount = 0;
                for (const fileUrl of selectedFiles) {
                  try {
                    const relativePath = decodeURIComponent(fileUrl.substring(finalUrl.length));
                    const parts = relativePath.split('/');
                    const fileName = parts.pop();

                    let currentDirHandle = baseFolderHandle;
                    for (const part of parts) {
                      currentDirHandle = await currentDirHandle.getDirectoryHandle(part, { create: true });
                    }

                    const fileRes = await fetch(fileUrl);
                    if (fileRes.ok) {
                      const blob = await fileRes.blob();
                      const fileHandle = await currentDirHandle.getFileHandle(fileName, { create: true });
                      const writable = await fileHandle.createWritable();
                      await writable.write(blob);
                      await writable.close();
                      currentCount++;
                      btnElement.textContent = `保存中 (${currentCount}/${selectedFiles.length})`;
                    }
                  } catch (e) { console.error('Failed raw file save:', fileUrl, e); }
                }
                btnElement.textContent = '完了';
                setTimeout(() => resetButton(btnElement, originalText), 1500);
              } else if (downloadSettings.format === 'zip') {
                // ZIP形式で書き込み
                btnElement.textContent = 'ZIP構築中...';
                const zip = new JSZip();
                let currentCount = 0;

                for (const fileUrl of selectedFiles) {
                  try {
                    const relativePath = decodeURIComponent(fileUrl.substring(finalUrl.length));
                    const fileRes = await fetch(fileUrl);
                    if (fileRes.ok) {
                      const blob = await fileRes.blob();
                      zip.file(relativePath, blob);
                      currentCount++;
                      btnElement.textContent = `ZIP構築中 (${currentCount}/${selectedFiles.length})`;
                    }
                  } catch (e) { }
                }

                btnElement.textContent = 'ZIP生成中...';
                const zipBlob = await zip.generateAsync({ type: 'blob' });

                btnElement.textContent = '書込中...';
                const writable = await downloadSettings.handle.createWritable();
                await writable.write(zipBlob);
                await writable.close();

                btnElement.textContent = '完了';
                setTimeout(() => resetButton(btnElement, originalText), 1500);
              }
            }
          } catch (e) {
            // エクスプローラーキャンセル等
            resetButton(btnElement, originalText);
          }
        },
        onCancel: () => resetButton(btnElement, originalText)
      });
    }
  } catch (err) {
    console.error('KULMS Downloader Error:', err);
    alert('エラーが発生しました: ' + err.message);
    resetButton(btnElement, originalText);
  }
}

function resetButton(btn, text) {
  btn.textContent = text;
  btn.style.pointerEvents = 'auto';
}

function getFilenameFromUrl(url) {
  let name = decodeURIComponent(url.split('/').pop());
  return name.replace(/[#?].*$/, "");
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 再帰的にディレクトリを辿り、ファイル一覧を取得する
async function fetchFolderList(folderUrl, fileList, rootUrl) {
  try {
    const res = await fetch(folderUrl);
    if (!res.ok) return;
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const links = Array.from(doc.querySelectorAll('a'));

    for (const link of links) {
      let href = link.getAttribute('href');
      // 親ディレクトリへのリンクやページ内リンクを除外
      if (!href || href === '../' || href.startsWith('?') || href.startsWith('/') || href.startsWith('http') || href.startsWith('#')) continue;

      let parsedHref;
      try {
        parsedHref = new URL(href, folderUrl).href;
      } catch (e) { continue; }

      if (!parsedHref.startsWith(folderUrl)) continue;

      const relativeToCurrent = parsedHref.substring(folderUrl.length);
      if (relativeToCurrent.startsWith('?') || relativeToCurrent === '') continue;

      if (parsedHref.endsWith('/')) {
        // 子フォルダなら再帰的に取得
        await fetchFolderList(parsedHref, fileList, rootUrl);
      } else {
        // 最終的なパスを保存
        fileList.push({
          url: parsedHref,
          displayPath: decodeURIComponent(parsedHref.substring(rootUrl.length))
        });
      }
    }
  } catch (e) {
    console.error("Failed to read folder contents:", folderUrl, e);
  }
}

// ファイル選択用の木構造モーダルUI
function showSelectionModal({ fileList, defaultName, isFolder, onConfirm, onCancel }) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#fff;border-radius:8px;padding:22px;width:90%;max-width:650px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 6px 20px rgba(0,0,0,0.3);';

  const title = document.createElement('h3');
  title.textContent = 'ダウンロード設定とファイル選択';
  title.style.cssText = 'margin-top:0;font-size:18px;border-bottom:1px solid #ddd;padding-bottom:12px;margin-bottom:16px;color:#2c3e50;';

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:12px;margin-bottom:12px;';

  const btnSelectAll = document.createElement('button');
  btnSelectAll.textContent = 'すべて選択';
  btnSelectAll.className = 'btn btn-sm btn-outline-secondary';
  btnSelectAll.type = 'button';

  const btnDeselectAll = document.createElement('button');
  btnDeselectAll.textContent = 'すべて解除';
  btnDeselectAll.className = 'btn btn-sm btn-outline-secondary';
  btnDeselectAll.type = 'button';

  controls.appendChild(btnSelectAll);
  controls.appendChild(btnDeselectAll);

  const listContainer = document.createElement('div');
  listContainer.style.cssText = 'flex-grow:1;overflow-y:auto;border:1px solid #ddd;padding:14px;margin-bottom:16px;background:#fafafa;border-radius:4px;';

  // ツリー構築
  const tree = {};
  fileList.forEach(file => {
    const parts = file.displayPath.split('/');
    let current = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = { _isDir: true, children: {} };
      }
      current = current[part].children;
    }
    const filename = parts[parts.length - 1];
    if (filename) {
      current[filename] = { _isDir: false, url: file.url };
    }
  });

  const checkboxes = [];

  function renderTree(node, container) {
    const ul = document.createElement('ul');
    ul.style.listStyleType = 'none';
    ul.style.paddingLeft = container === listContainer ? '0' : '24px';
    ul.style.margin = '0';

    const nodeCheckboxes = [];
    const myItems = [];

    for (const [key, childNode] of Object.entries(node)) {
      const li = document.createElement('li');
      li.style.margin = '4px 0';

      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.cursor = 'pointer';
      label.style.color = '#444';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.style.cssText = 'margin-right:8px;width:16px;height:16px;flex-shrink:0;';
      checkboxes.push(cb);
      nodeCheckboxes.push(cb);

      const text = document.createElement('span');
      text.style.fontSize = '14px';

      label.appendChild(cb);
      label.appendChild(text);
      li.appendChild(label);
      ul.appendChild(li);

      const item = { cb, children: [] };
      myItems.push(item);

      if (childNode._isDir) {
        text.innerHTML = '<span style="font-size:16px; margin-right:6px;">📁</span><span style="font-weight:bold;">' + key + '</span>';
        const childrenContainer = document.createElement('div');
        li.appendChild(childrenContainer);

        const childResult = renderTree(childNode.children, childrenContainer);
        item.children = childResult.myItems;
        nodeCheckboxes.push(...childResult.nodeCheckboxes);
      } else {
        text.innerHTML = '<span style="font-size:16px; margin-right:6px;">📄</span>' + key;
        cb.value = childNode.url;
        cb.dataset.isFile = 'true';
      }
    }
    container.appendChild(ul);
    return { nodeCheckboxes, myItems };
  }

  const treeResult = renderTree(tree, listContainer);

  function propagateDown(item, checked) {
    item.children.forEach(child => {
      child.cb.checked = checked;
      propagateDown(child, checked);
    });
  }

  function propagateUp(item) {
    if (item.parent) {
      const anyChecked = item.parent.children.some(c => c.cb.checked);
      item.parent.cb.checked = anyChecked;
      propagateUp(item.parent);
    }
  }

  function wireEvents(items, parentItem) {
    items.forEach(item => {
      item.parent = parentItem;
      if (item.children.length > 0) {
        wireEvents(item.children, item);
      }
      item.cb.addEventListener('change', () => {
        propagateDown(item, item.cb.checked);
        propagateUp(item);
      });
    });
  }

  wireEvents(treeResult.myItems, null);

  btnSelectAll.onclick = () => {
    treeResult.myItems.forEach(item => {
      item.cb.checked = true;
      propagateDown(item, true);
    });
  };
  btnDeselectAll.onclick = () => {
    treeResult.myItems.forEach(item => {
      item.cb.checked = false;
      propagateDown(item, false);
    });
  };

  // --- 保存方法のUI ---
  const saveActionContainer = document.createElement('div');
  saveActionContainer.style.cssText = 'border-top:1px solid #ccc; padding-top:12px; margin-bottom:8px; display:flex; flex-direction:column; gap:12px;';

  // 形式選択
  const formatContainer = document.createElement('div');
  formatContainer.style.cssText = 'display:flex; gap:16px; align-items:center; font-size:14px; font-weight:bold;';
  const formatLabelText = document.createElement('span');
  formatLabelText.textContent = '保存形式:';

  const rawRadio = document.createElement('input');
  rawRadio.type = 'radio';
  rawRadio.name = 'saveFormat';
  rawRadio.value = 'raw';
  rawRadio.checked = true;
  const rawLabel = document.createElement('label');
  rawLabel.style.cssText = 'cursor:pointer; display:flex; align-items:center; gap:4px;';
  rawLabel.appendChild(rawRadio);
  rawLabel.appendChild(document.createTextNode('フォルダ形式'));

  const zipRadio = document.createElement('input');
  zipRadio.type = 'radio';
  zipRadio.name = 'saveFormat';
  zipRadio.value = 'zip';
  const zipLabel = document.createElement('label');
  zipLabel.style.cssText = 'cursor:pointer; display:flex; align-items:center; gap:4px;';
  zipLabel.appendChild(zipRadio);
  zipLabel.appendChild(document.createTextNode('ZIP圧縮'));

  formatContainer.appendChild(formatLabelText);
  formatContainer.appendChild(rawLabel);
  formatContainer.appendChild(zipLabel);

  // 場所指定
  const destContainer = document.createElement('div');
  destContainer.style.cssText = 'display:flex; flex-direction:column; gap:8px; border-left:3px solid #eee; padding-left:12px; margin-left:4px;';

  const modeDefaultLabel = document.createElement('label');
  modeDefaultLabel.style.cssText = 'display:flex; align-items:center; cursor:pointer; font-size:14px; color:#333;';
  const modeDefaultRadio = document.createElement('input');
  modeDefaultRadio.type = 'radio';
  modeDefaultRadio.name = 'saveMode';
  modeDefaultRadio.value = 'default';
  modeDefaultRadio.checked = true;
  modeDefaultRadio.style.marginRight = '8px';
  modeDefaultLabel.appendChild(modeDefaultRadio);
  modeDefaultLabel.appendChild(document.createTextNode('標準のダウンロードフォルダへ保存する（指定不要）'));

  const modeCustomLabel = document.createElement('label');
  modeCustomLabel.style.cssText = 'display:flex; align-items:center; cursor:pointer; font-size:14px; color:#333;';
  const modeCustomRadio = document.createElement('input');
  modeCustomRadio.type = 'radio';
  modeCustomRadio.name = 'saveMode';
  modeCustomRadio.value = 'custom';
  modeCustomRadio.style.marginRight = '8px';
  modeCustomLabel.appendChild(modeCustomRadio);
  modeCustomLabel.appendChild(document.createTextNode('保存先のフォルダを指定する'));

  const customDetails = document.createElement('div');
  customDetails.style.cssText = 'margin-left:24px; display:none; flex-direction:column; gap:8px;';

  const browseContainer = document.createElement('div');
  browseContainer.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;';
  const browseBtn = document.createElement('button');
  browseBtn.textContent = 'エクスプローラーを開く';
  browseBtn.className = 'btn btn-sm btn-outline-primary';
  browseBtn.style.padding = '4px 10px';
  browseBtn.style.cursor = 'pointer';

  const previewPath = document.createElement('span');
  previewPath.textContent = '選択中: 未選択';
  previewPath.style.cssText = 'font-size:12px; color:#c0392b; font-weight:bold; background:#fef0f0; padding:2px 6px; border-radius:3px; max-width:100%; word-break:break-all;';

  browseContainer.appendChild(browseBtn);
  browseContainer.appendChild(previewPath);
  customDetails.appendChild(browseContainer);

  const formatHint = document.createElement('div');
  formatHint.style.cssText = 'font-size:12px; color:#666; line-height:1.4;';
  formatHint.innerHTML = '※chromeセキュリティのため「ダウンロード」や「デスクトップ」直下などは直接選べません。その中に<b>新しいフォルダを作成して</b>選んでください。';
  customDetails.appendChild(formatHint);

  destContainer.appendChild(modeDefaultLabel);
  destContainer.appendChild(modeCustomLabel);
  destContainer.appendChild(customDetails);

  if (!isFolder) {
    controls.style.display = 'none'; // ファイル単体なら全選択ボタン等を隠す
    formatContainer.style.display = 'none'; // 形式UI隠す
  }

  saveActionContainer.appendChild(formatContainer);
  saveActionContainer.appendChild(destContainer);

  // ファイルシステムアクセスチェック
  const isFSASupported = 'showDirectoryPicker' in window;

  // ステート管理
  let selectedHandle = null;

  modeDefaultRadio.onchange = modeCustomRadio.onchange = () => {
    customDetails.style.display = modeCustomRadio.checked ? 'flex' : 'none';
    if (modeCustomRadio.checked && !isFSASupported && rawRadio.checked) {
      alert('お使いのブラウザはローカルフォルダの直接選択(File System Access API)に対応していません。標準ダウンロードか、ZIP形式を選択してください。');
      zipRadio.checked = true;
      zipRadio.onchange();
    }
  };

  rawRadio.onchange = zipRadio.onchange = () => {
    selectedHandle = null;
    previewPath.textContent = '選択中: 未選択';
    previewPath.style.color = '#c0392b';
    previewPath.style.background = '#fef0f0';
    browseBtn.textContent = (!isFolder || zipRadio.checked) ? '保存先を決める' : '保存先の親フォルダを決める';
  };

  // ブラウズボタンで事前にパス・Handleを取得
  browseBtn.onclick = async () => {
    try {
      if (!isFolder) {
        selectedHandle = await window.showSaveFilePicker({ suggestedName: defaultName });
        previewPath.textContent = `選択中: 📄 ${selectedHandle.name}`;
      } else if (rawRadio.checked) {
        selectedHandle = await window.showDirectoryPicker({ id: 'kulms-folder-downloader' });
        previewPath.textContent = `選択中: 📁 ${selectedHandle.name}`;
      } else {
        selectedHandle = await window.showSaveFilePicker({
          suggestedName: defaultName + '.zip',
          types: [{ description: 'ZIP File', accept: { 'application/zip': ['.zip'] } }]
        });
        previewPath.textContent = `選択中: 📦 ${selectedHandle.name}`;
      }
      previewPath.style.color = '#27ae60';
      previewPath.style.background = '#eafaf1';
    } catch (e) {
      // キャンセルされた場合など
    }
  };

  // --- フッターUI群 ---
  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;padding-top:12px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.type = 'button';
  cancelBtn.onclick = () => {
    document.body.removeChild(overlay);
    onCancel();
  };

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'ダウンロード開始';
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.style.padding = '6px 20px';
  confirmBtn.style.fontWeight = 'bold';
  confirmBtn.type = 'button';
  confirmBtn.onclick = () => {
    const selectedUrls = checkboxes.filter(cb => cb.dataset.isFile && cb.checked).map(cb => cb.value);

    // カスタムで未選択の場合
    if (modeCustomRadio.checked && !selectedHandle) {
      alert('保存先が指定されていません。「' + browseBtn.textContent + '」ボタンから場所を選択してください。');
      return; // prevent closing
    }

    const downloadSettings = {
      mode: modeDefaultRadio.checked ? 'default' : 'custom',
      format: rawRadio.checked ? 'raw' : 'zip',
      handle: selectedHandle
    };

    document.body.removeChild(overlay);
    onConfirm(selectedUrls, downloadSettings);
  };

  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);

  modal.appendChild(title);
  modal.appendChild(controls);
  modal.appendChild(listContainer);
  modal.appendChild(saveActionContainer);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// 起動
initObserver();
