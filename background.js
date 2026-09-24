// 监听来自 content.js 的网络请求指令
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'FETCH_CROSS_DOMAIN') {
        const { url, method = 'GET', headers = {}, data, responseType } = request.options;

        const fetchOptions = {
            method: method,
            headers: headers
        };

        if (data && method.toUpperCase() !== 'GET') {
            fetchOptions.body = data;
        }

        fetch(url, fetchOptions)
            .then(async (res) => {
                if (responseType === 'arraybuffer') {
                    const buf = await res.arrayBuffer();
                    let binary = '';
                    const bytes = new Uint8Array(buf);
                    const len = bytes.byteLength;
                    const chunkSize = 0x8000;
                    for (let i = 0; i < len; i += chunkSize) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
                    }
                    sendResponse({
                        success: true,
                        status: res.status,
                        base64Data: btoa(binary)
                    });
                } else {
                    const text = await res.text();
                    sendResponse({
                        success: true,
                        status: res.status,
                        data: text
                    });
                }
            })
            .catch((err) => {
                sendResponse({
                    success: false,
                    status: 0,
                    error: err.message || '网络请求错误',
                    data: ''
                });
            });

        return true;
    }
});