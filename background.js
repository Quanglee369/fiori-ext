// background.js

console.log("[BACKGROUND] Service Worker đã khởi động hoặc thức dậy.");

const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';
let creatingPromise = null;

// --- LẮNG NGHE YÊU CẦU TỪ CONTENT SCRIPT (KHI NHẤN NÚT BẤM) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[BACKGROUND] Nhận được tin nhắn:", message);

    // Chỉ xử lý tin nhắn yêu cầu dữ liệu clipboard
    if (message.type === "REQUEST_CLIPBOARD_DATA") {
        console.log("[BACKGROUND] Nhận được yêu cầu REQUEST_CLIPBOARD_DATA từ content script.");
        
        // Bắt đầu chu trình lấy dữ liệu
        getClipboardAndParse()
            .then(parsedData => {
                console.log("[BACKGROUND] Gửi lại dữ liệu đã phân tích cho content script:", parsedData);
                sendResponse({ data: parsedData });
            })
            .catch(error => {
                console.error("Lỗi trong chu trình getClipboardAndParse:", error);
                sendResponse({ data: null, error: error.message });
            });
            
        // Rất quan trọng: return true để báo cho Chrome biết rằng sendResponse sẽ được gọi bất đồng bộ.
        return true; 
    }
    // === THÊM KHỐI CODE MỚI NÀY VÀO ===
    if (message.type === "WRITE_CLIPBOARD_DATA") {
        console.log("[BACKGROUND] Nhận được yêu cầu WRITE_CLIPBOARD_DATA.");
        setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH)
            .then(() => {
                // Gửi tin nhắn đến offscreen để *ghi*
                return chrome.runtime.sendMessage({
                    type: 'WRITE_CLIPBOARD_TO_OFFSCREEN',
                    data: message.data
                });
            })
            .then((response) => {
                if (response && response.success) {
                    sendResponse({ success: true });
                } else {
                    throw new Error(response?.error || "Lỗi không xác định từ offscreen writing");
                }
            })
            .catch(error => {
                console.error("Lỗi trong chu trình WRITE_CLIPBOARD_DATA:", error);
                sendResponse({ success: false, error: error.message });
            });
        return true; // Quan trọng: giữ bất đồng bộ
    }
    // === KẾT THÚC KHỐI CODE MỚI ===
});

// --- CÁC HÀM HELPER (Không thay đổi) ---

async function getClipboardAndParse() {
    console.log("[BACKGROUND] Bắt đầu hàm getClipboardAndParse.");
    await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
    
    console.log("[BACKGROUND] Gửi yêu cầu GET_CLIPBOARD_FROM_OFFSCREEN đến offscreen.js");
    const response = await chrome.runtime.sendMessage({ type: 'GET_CLIPBOARD_FROM_OFFSCREEN' });
    
    console.log("[BACKGROUND] Đã nhận phản hồi từ offscreen.js");

    if (response && response.error) {
        throw new Error(response.error);
    }
    const rawText = response ? response.data : null;
    
    return parseClipboardData(rawText);
}

async function setupOffscreenDocument(path) {
    // Sử dụng API mới hơn, ổn định hơn
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
        console.log("[BACKGROUND] Offscreen document đã tồn tại.");
        return;
    }

    console.log("[BACKGROUND] Đang tạo Offscreen document...");
    await chrome.offscreen.createDocument({
        url: path,
        reasons: ['CLIPBOARD'],
        justification: 'Cần thiết để truy cập API clipboard',
    });
    console.log("[BACKGROUND] Offscreen document đã được tạo thành công.");
}

function parseClipboardData(rawText) {
    if (!rawText) {
        console.log("[BACKGROUND] Dữ liệu clipboard rỗng.");
        return null;
    }
    try {
        const lines = rawText.trim().split('\n');
        if (lines.length < 2) {
            console.log("[BACKGROUND] Dữ liệu clipboard không đủ dòng.");
            return null;
        }
        
        const separator = "@#";
        const headers = lines.shift().trim().split(separator);

        const headerMap = {};
        headers.forEach((header, index) => {
            headerMap[header.trim()] = index;
        });

        if (headerMap['PO'] === undefined || headerMap['Item'] === undefined) {
            console.log("[BACKGROUND] Không tìm thấy header 'PO' hoặc 'Item' trong clipboard.");
            return null;
        }

        const data = lines.map(line => {
            const values = line.split(separator);
            const rowObject = {};
            for (const headerName in headerMap) {
                const index = headerMap[headerName];
                rowObject[headerName] = values[index] ? values[index].trim() : "";
            }
            return rowObject;
        }).filter(item => item.PO && item.Item);

        console.log(`[BACKGROUND] Phân tích thành công ${data.length} dòng dữ liệu.`);
        return data.length > 0 ? data : null;
    } catch (error) {
        console.error("Lỗi khi phân tích dữ liệu clipboard:", error);
        return null;
    }
}