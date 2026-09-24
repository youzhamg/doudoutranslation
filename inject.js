(function() {
    function saveSubData(url, text) {
        if (!text || text.length < 30) return;
        window.dispatchEvent(new CustomEvent('__bilingual_yt_sub_caught', {
            detail: { url: String(url), text: text }
        }));
    }

    try {
        const originalFetch = window.fetch;
        if (typeof originalFetch === 'function') {
            window.fetch = function(...args) {
                const result = originalFetch.apply(this, args);
                try {
                    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                    if (url && /timedtext/i.test(String(url))) {
                        Promise.resolve(result).then(response => {
                            try {
                                if (response && typeof response.clone === 'function') {
                                    response.clone().text().then(text => saveSubData(url, text)).catch(() => {});
                                }
                            } catch (e) {}
                        }).catch(() => {});
                    }
                } catch (e) {}
                return result;
            };
        }
    } catch (e) {}

    try {
        const XHR = window.XMLHttpRequest;
        if (XHR && XHR.prototype) {
            const originalOpen = XHR.prototype.open;
            const originalSend = XHR.prototype.send;
            XHR.prototype.open = function(method, url) {
                this.__bilingual_yt_sub_url = url;
                return originalOpen.apply(this, arguments);
            };
            XHR.prototype.send = function() {
                const url = this.__bilingual_yt_sub_url;
                if (url && /timedtext/i.test(String(url))) {
                    try {
                        this.addEventListener('load', () => {
                            try {
                                saveSubData(url, this.responseText || this.response || '');
                            } catch (e) {}
                        });
                    } catch (e) {}
                }
                return originalSend.apply(this, arguments);
            };
        }
    } catch (e) {}
})();