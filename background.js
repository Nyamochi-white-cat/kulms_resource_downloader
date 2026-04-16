chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DOWNLOAD_FILE') {
        const downloadOptions = {
            url: message.url,
            filename: message.filename,
            conflictAction: 'uniquify'
        };
        chrome.downloads.download(downloadOptions, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("Download Error:", chrome.runtime.lastError);
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ success: true, downloadId });
            }
        });
        return true; // 非同期でレスポンスを返すために必要
    }
});
