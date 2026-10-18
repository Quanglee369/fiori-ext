// content.js

// --- BIẾN TOÀN CỤC VÀ HẰNG SỐ ---
let currentAppState = null;
let abortController = new AbortController();
let currentDropdown = null;
let tickedRows = new Set();
let isTableUpdating = false;
let capturedPdfData = new Map(); // <-- Thêm biến lưu PDF data
let isCapturing = false; // <-- Biến này dùng chung cho cả batch QR
let processedBlobUrls = new Set();

const STATE_NONE = 'NONE';
const STATE_GOODS_RECEIPT = 'GOODS_RECEIPT';
const STATE_WEIGH_BRIDGE_MAIN = 'WEIGH_BRIDGE_MAIN';
const STATE_WEIGH_BRIDGE_DIALOG = 'WEIGH_BRIDGE_DIALOG';


// --- CÁC HÀM HELPER CHUNG ---

/**
 * Giả lập một cú click "mạnh mẽ" hơn bằng cách dispatch mousedown/mouseup/click.
 * Hữu ích cho các framework JS phức tạp (như SAPUI5) không phản hồi với .click() đơn giản.
 */
function dispatchRobustClick(element) {
    if (!element) return;

    const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0, // Nút chuột chính
        buttons: 1,
        clientX: element.getBoundingClientRect().left,
        clientY: element.getBoundingClientRect().top
    };

    // 1. Gửi sự kiện Mousedown
    element.dispatchEvent(new MouseEvent('mousedown', eventOptions));

    // 2. Gửi sự kiện Mouseup
    element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
    
    // 3. Gửi sự kiện Click (để đảm bảo)
    element.dispatchEvent(new MouseEvent('click', eventOptions));
    
    // 4. Gọi hàm click() gốc (dự phòng)
    // Đôi khi framework cần cả hai
    element.click();
}

function findElementByText(selector, text) { const elements = document.querySelectorAll(selector); for (const el of elements) { if (el.textContent.trim() === text) { return el; } } return null; }

/** Chờ element xuất hiện */
function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            const el = document.querySelector(selector);
            if (el) {
                clearInterval(interval);
                resolve(el);
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                reject(new Error(`Element ${selector} không tìm thấy sau ${timeout}ms`));
            }
        }, 20);
    });
}

/** Chờ element biến mất (hoặc bị ẩn) */
function waitForElementToDisappear(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        // Giảm thời gian lặp kiểm tra xuống 50ms (thay vì 100ms) để nhanh hơn
        const interval = setInterval(() => {
            const el = document.querySelector(selector);
            
            // KIỂM TRA MỚI:
            // Coi như "biến mất" nếu:
            // 1. Element không còn trong DOM (!el)
            // 2. Element bị ẩn (el.style.display === 'none')
            // 3. Element bị ẩn (el.style.visibility === 'hidden')
            const isHidden = !el || 
                           (el.style && el.style.display === 'none') || 
                           (el.style && el.style.visibility === 'hidden');

            if (isHidden) {
                clearInterval(interval);
                resolve(); // Hoàn thành ngay lập tức
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                // Vẫn reject nếu hết giờ (phòng trường hợp nó kẹt thật)
                reject(new Error(`Element ${selector} không biến mất (hoặc ẩn) sau ${timeout}ms`));
            }
        }, 50); // Kiểm tra mỗi 50ms
    });
}

function fillFioriInputBySelector(selector, value) {
    const inputElement = document.querySelector(selector);
    if (inputElement && value != null) {
        inputElement.value = value;
        // Dispatch events to ensure Fiori recognizes the change
        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        inputElement.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    return false;
}

function getFormattedDate(separator = '') {
    const date = new Date();
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}${separator}${month}${separator}${year}`;
}

function showNotification(message, isError = false) {
    const existingNotification = document.getElementById('extension-notification');
    if (existingNotification) {
        existingNotification.remove();
    }

    const notification = document.createElement('div');
    notification.id = 'extension-notification';
    notification.textContent = message;
    Object.assign(notification.style, {
        position: 'fixed', top: '20px', right: '20px',
        backgroundColor: isError ? '#f44336' : '#4CAF50', color: 'white',
        padding: '15px 20px', borderRadius: '5px', zIndex: '10000',
        boxShadow: '0 4px 8px rgba(0,0,0,0.2)', maxWidth: '300px',
        wordWrap: 'break-word'
    });
    document.body.appendChild(notification);
    setTimeout(() => {
        if (document.body.contains(notification)) {
            document.body.removeChild(notification);
        }
    }, isError ? 5000 : 3000); // Show errors longer
}


// === THÊM MỚI: HẰNG SỐ VÀ HÀM TÁI TẠO CLIPBOARD ===

// Hằng số này PHẢI KHỚP với Outlook script để đảm bảo thứ tự cột
const CLIPBOARD_HEADERS = ["PO", "B/L NO.", "CD No.", "Container No.", "Supplier", "LOT NO.", "Item"];

/**
 * Tái cấu trúc mảng object trở lại thành chuỗi clipboard,
 * sử dụng danh sách header đã định nghĩa để đảm bảo thứ tự.
 * @param {Object[]} dataObjects Mảng dữ liệu (đã được cập nhật).
 * @param {string[]} headerKeys Mảng header (để giữ đúng thứ tự cột).
 * @returns {string}
 */
function reconstructClipboardData(dataObjects, headerKeys) {
    // 1. Tạo lại dòng header
    const headerString = headerKeys.join('@#');

    // 2. Tạo lại các dòng dữ liệu
    const dataRowStrings = dataObjects.map(obj => {
        // Lặp qua headerKeys để đảm bảo đúng thứ tự cột
        return headerKeys.map(key => obj[key] || '').join('@#');
    });

    // 3. Ghép header và data
    return headerString + '\n' + dataRowStrings.join('\n');
}

/**
 * HÀM MỚI: TẠO NÚT SỬA DATA
 */
function createEditDataButton() {
    const button = document.createElement('button');
    button.id = 'edit-clipboard-button';
    button.textContent = 'Sửa data copy';
    Object.assign(button.style, {
        padding: '8px 15px',
        backgroundColor: '#17a2b8', // Màu info (xanh lơ)
        color: 'white',
        border: 'none',
        borderRadius: '5px',
        cursor: 'pointer',
        fontSize: '14px',
        width: '100%'
    });

    button.addEventListener('click', async () => {
        button.textContent = 'Đang đọc...';
        button.disabled = true;
        try {
            const response = await chrome.runtime.sendMessage({ type: "REQUEST_CLIPBOARD_DATA" });
            
            // SỬA LỖI: Kiểm tra response.data là một Array (như code gốc của bạn)
            if (response && Array.isArray(response.data) && response.data.length > 0) {
                // response.data đã là một mảng object
                const modal = createEditDataModal(response.data);
                document.body.appendChild(modal);
            } else if (response && response.error) {
                showNotification(`Lỗi clipboard: ${response.error}`, true);
            } else {
                showNotification('Dữ liệu clipboard rỗng hoặc không hợp lệ.', true);
            }
        } catch (error) {
            console.error("[CONTENT] Lỗi khi yêu cầu dữ liệu clipboard để sửa:", error);
            showNotification(`Lỗi kết nối extension: ${error.message}`, true);
        } finally {
            button.textContent = 'Sửa data copy';
            button.disabled = false;
        }
    });
    return button;
}

/**
 * HÀM MỚI: TẠO MODAL SỬA DATA (ĐÃ SỬA FORMAT - Approach 3: Standard Table CSS)
 * @param {Object[]} parsedData Mảng object data (đã được parse bởi background.js)
 */
function createEditDataModal(parsedData) {
    const overlay = document.createElement('div');
    overlay.className = 'extension-modal-overlay';
    Object.assign(overlay.style, {
        position: 'fixed', top: '0', left: '0',
        width: '100vw', height: '100vh',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        zIndex: '10000', display: 'flex',
        justifyContent: 'center', alignItems: 'center'
    });

    const modalContent = document.createElement('div');
    Object.assign(modalContent.style, {
        background: 'white', padding: '20px',
        borderRadius: '8px', boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
        zIndex: '10001', width: 'auto', minWidth: '500px', // Adjusted width slightly
        maxHeight: '80vh', display: 'flex', flexDirection: 'column'
    });

    const title = document.createElement('h3');
    title.textContent = 'Sửa dữ liệu Item';
    title.style.marginTop = '0';
    modalContent.appendChild(title);

    const tableContainer = document.createElement('div');
    tableContainer.style.overflowY = 'auto'; // Add scroll if needed

    const table = document.createElement('table');
    Object.assign(table.style, {
        width: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed' // Helps with consistent column widths
    });

    // --- SỬA FORMAT BẢNG (Standard Table CSS) ---
    table.innerHTML = `
        <thead style="background-color: #f8f9fa;">
            <tr>
                <th style="padding: 10px 12px; text-align: left; border-bottom: 2px solid #dee2e6; width: 25%; font-weight: 600;">PO</th>
                <th style="padding: 10px 12px; text-align: left; border-bottom: 2px solid #dee2e6; width: 50%; font-weight: 600;">LOT NO.</th>
                <th style="padding: 10px 12px; text-align: right; border-bottom: 2px solid #dee2e6; width: 25%; font-weight: 600;">Item</th>
            </tr>
        </thead>
        <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    parsedData.forEach((item, index) => {
        const tr = document.createElement('tr');
        // Add subtle hover effect
        tr.style.transition = 'background-color 0.1s ease';
        tr.onmouseenter = () => tr.style.backgroundColor = '#f1f3f5';
        tr.onmouseleave = () => tr.style.backgroundColor = 'transparent';

        // Cell PO
        const tdPO = document.createElement('td');
        Object.assign(tdPO.style, {
            padding: '8px 12px',
            borderBottom: '1px solid #e9ecef', // Lighter border for rows
            textAlign: 'left',
            verticalAlign: 'middle', // Align content vertically center
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        });
        tdPO.textContent = item.PO;
        tr.appendChild(tdPO);

        // Cell LOT NO.
        const tdLot = document.createElement('td');
        Object.assign(tdLot.style, {
            padding: '8px 12px',
            borderBottom: '1px solid #e9ecef',
            textAlign: 'left',
            verticalAlign: 'middle',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        });
        tdLot.textContent = item['LOT NO.'];
        tr.appendChild(tdLot);

        // Cell Item (with Input)
        const tdItem = document.createElement('td');
        Object.assign(tdItem.style, {
            padding: '4px 12px', // Reduce vertical padding for input alignment
            borderBottom: '1px solid #e9ecef',
            textAlign: 'right', // Align the content (input) to the right
            verticalAlign: 'middle'
        });

        const input = document.createElement('input');
        input.type = 'text';
        input.value = item.Item;
        input.className = 'edit-item-input';
        input.dataset.originalIndex = index;
        Object.assign(input.style, {
            width: '70px', // Fixed width for the input
            textAlign: 'right',
            padding: '6px 8px', // Adjust input padding
            border: '1px solid #ced4da', // Standard border color
            borderRadius: '4px',
            fontSize: 'inherit', // Use table font size
            boxSizing: 'border-box'
        });
        tdItem.appendChild(input);
        tr.appendChild(tdItem);
        // --- KẾT THÚC SỬA FORMAT ---

        tbody.appendChild(tr);
    });

    tableContainer.appendChild(table);
    modalContent.appendChild(tableContainer);

    // --- Button Container (No changes needed here) ---
    const buttonContainer = document.createElement('div');
    Object.assign(buttonContainer.style, {
        display: 'flex', justifyContent: 'flex-end',
        gap: '10px', marginTop: '20px',
        borderTop: '1px solid #eee', paddingTop: '15px'
    });
    // Cancel Button
    const cancelButton = document.createElement('button');
    cancelButton.textContent = 'Hủy';
    Object.assign(cancelButton.style, { /* ... styles ... */
        padding: '8px 16px', border: '1px solid #ccc',
        borderRadius: '5px', cursor: 'pointer', background: '#f8f9fa'
    });
    cancelButton.onclick = () => overlay.remove();
    // Save Button
    const saveButton = document.createElement('button');
    saveButton.textContent = 'Lưu vào Clipboard';
    Object.assign(saveButton.style, { /* ... styles ... */
        padding: '8px 16px', border: 'none',
        borderRadius: '5px', cursor: 'pointer',
        background: '#28a745', color: 'white'
    });
    saveButton.onclick = async () => {
        // ... (save logic remains the same) ...
        saveButton.textContent = 'Đang lưu...';
        saveButton.disabled = true;
        cancelButton.disabled = true;
        const updatedData = JSON.parse(JSON.stringify(parsedData));
        const inputs = modalContent.querySelectorAll('.edit-item-input');
        inputs.forEach(input => {
            const index = parseInt(input.dataset.originalIndex, 10);
            if (!isNaN(index) && updatedData[index]) {
                updatedData[index].Item = input.value;
            }
        });
        const newClipboardString = reconstructClipboardData(updatedData, CLIPBOARD_HEADERS);
        try {
            const response = await chrome.runtime.sendMessage({ type: "WRITE_CLIPBOARD_DATA", data: newClipboardString });
            if (response && response.success) {
                showNotification('Đã cập nhật clipboard thành công!', false);
                overlay.remove();
            } else {
                showNotification(response?.error || 'Lỗi khi ghi vào clipboard.', true);
                saveButton.textContent = 'Lưu vào Clipboard';
                saveButton.disabled = false;
                cancelButton.disabled = false;
            }
        } catch (error) {
            console.error("[CONTENT] Lỗi khi gửi WRITE_CLIPBOARD_DATA:", error);
            showNotification(`Lỗi extension: ${error.message}`, true);
            saveButton.textContent = 'Lưu vào Clipboard';
            saveButton.disabled = false;
            cancelButton.disabled = false;
        }
    };
    buttonContainer.appendChild(cancelButton);
    buttonContainer.appendChild(saveButton);
    modalContent.appendChild(buttonContainer);
    // --- End Button Container ---

    overlay.appendChild(modalContent);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });

    return overlay;
}

// --- LẮNG NGHE TIN NHẮN TỪ BACKGROUND SCRIPT ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Keep original listener logic if any was intended
    return false; // Indicates asynchronous response is not used here
});


// --- NHẠC TRƯỞNG VÀ STATE MACHINE ---
const mainObserver = new MutationObserver(() => {
    const newState = determineCurrentState();
    if (newState !== currentAppState) {
        // console.log(`State changed: ${currentAppState} -> ${newState}`); // Optional logging
        cleanupAllFeatures();
        initializeFeaturesForState(newState);
        currentAppState = newState;
    }
});
mainObserver.observe(document.body, { childList: true, subtree: true });

function determineCurrentState() {
    const purchaseOrderDialog = Array.from(document.querySelectorAll('div[role="dialog"]'))
        .find(d => d.querySelector('span[id*="dialog-title-inner"]')?.textContent === 'Select Purchase Order');
    if (purchaseOrderDialog) return STATE_WEIGH_BRIDGE_DIALOG;
    const screenTitleElement = document.querySelector('h1.sapUshellHeadTitle');
    if (screenTitleElement) {
        const title = screenTitleElement.textContent.trim();
        if (title.includes('Goods Receipt')) return STATE_GOODS_RECEIPT;
        if (title.includes('Weigh Bridge')) return STATE_WEIGH_BRIDGE_MAIN;
    }
    return STATE_NONE;
}

function cleanupAllFeatures() {
    abortController.abort();
    abortController = new AbortController();

    // === THAY ĐỔI: Thêm '.extension-modal-overlay' ===
    const extensionElements = document.querySelectorAll('.extension-panel, .extension-modal-overlay');
    extensionElements.forEach(el => el.remove());

    if (currentDropdown && document.body.contains(currentDropdown)) currentDropdown.remove();

    // Reset state
    currentDropdown = null;
    tickedRows.clear();
    capturedPdfData.clear(); // <-- Dọn dẹp PDF data
    isTableUpdating = false;
    isCapturing = false; // <-- Reset cờ capturing
    processedBlobUrls.clear();
    const initializedElements = document.querySelectorAll('[data-tickbox-initialized], [data-extension-listener-attached]');
    initializedElements.forEach(el => {
        delete el.dataset.tickboxInitialized;
        delete el.dataset.extensionListenerAttached;
    });
}


function initializeFeaturesForState(state) {
    // Use a slightly longer delay to ensure Fiori UI is more stable
    setTimeout(() => {
        // Double-check state hasn't changed again during the delay
        if (determineCurrentState() !== state) return;

        switch (state) {
            case STATE_WEIGH_BRIDGE_MAIN:
                initWeighBridgeMainFeatures();
                break;
            case STATE_GOODS_RECEIPT:
                createGoodsReceiptPanel();
                break;
            case STATE_WEIGH_BRIDGE_DIALOG:
                const searchInput = document.querySelector('div[role="dialog"] input[id*="searchField-I"]');
                if (searchInput && !searchInput.dataset.extensionListenerAttached) { // Prevent re-attaching listener
                    initWeighBridgeDialogFeatures(searchInput);
                }
                break;
        }
    }, 750); // Increased delay
}

// --- LOGIC UI ĐÃ TÁI CẤU TRÚC ---

/** Tạo floating panel chung */
function createFloatingPanel(id, title) {
    const panel = document.createElement('div');
    panel.id = id;
    panel.className = 'extension-panel';
    Object.assign(panel.style, {
        position: 'fixed', top: '150px', right: '10px', width: '150px', // <-- Tăng chiều rộng
        backgroundColor: 'rgba(255, 255, 255, 0.95)', border: '1px solid #ccc',
        borderRadius: '8px', zIndex: '9990',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        padding: '10px', display: 'flex', flexDirection: 'column'
    });
    panel.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 5px; border-bottom: 1px solid #eee; cursor: grab;">
            <h3 style="margin: 0; font-size: 14px; color: #333; user-select: none;">${title}</h3>
            <span class="panel-toggle-btn" style="cursor: pointer; font-weight: bold; padding: 2px 5px; user-select: none;">&minus;</span>
        </div>
        <div class="panel-container" style="display: flex; flex-direction: column; gap: 8px;"></div>
    `; // <-- Thêm gap cho container

    const toggleBtn = panel.querySelector('.panel-toggle-btn');
    const container = panel.querySelector('.panel-container');
    const header = panel.querySelector('div'); // Panel header

    toggleBtn.addEventListener('click', (e) => {
         e.stopPropagation(); // Prevent drag from triggering toggle
        const isHidden = container.style.display === 'none';
        container.style.display = isHidden ? 'flex' : 'none'; // Use flex when showing
        toggleBtn.innerHTML = isHidden ? '&minus;' : '&#43;';
    });

    // Simple drag functionality
    let isDragging = false;
    let offsetX, offsetY;
    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        offsetX = e.clientX - panel.getBoundingClientRect().left;
        offsetY = e.clientY - panel.getBoundingClientRect().top;
        panel.style.cursor = 'grabbing';
        panel.style.userSelect = 'none'; // Prevent text selection while dragging
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panel.style.left = `${e.clientX - offsetX}px`;
        panel.style.top = `${e.clientY - offsetY}px`;
    });
    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            panel.style.cursor = 'default';
             panel.style.userSelect = 'auto';
        }
    });

    return panel;
}

/** Tạo nút Autofill chung */
function createAutofillButton() {
    const button = document.createElement('button');
    button.id = 'autofill-trigger-button';
    button.textContent = 'Autofill';
    Object.assign(button.style, {
        // marginTop removed, using gap in container instead
        padding: '8px 15px', backgroundColor: '#007bff', color: 'white',
        border: 'none', borderRadius: '5px', cursor: 'pointer',
        fontSize: '14px', width: '100%'
    });

    // --- ORIGINAL CLIPBOARD REQUEST LOGIC ---
    button.addEventListener('click', async () => {
        button.textContent = 'Đang xử lý...';
        button.disabled = true;
        try {
            // Send message to background script to request clipboard data
            const response = await chrome.runtime.sendMessage({ type: "REQUEST_CLIPBOARD_DATA" });

            if (response && response.data) {
                // Call handleAutofill with the received data
                await handleAutofill(response.data);
            } else if (response && response.error) {
                // Show specific error from background/offscreen script
                showNotification(`Lỗi clipboard: ${response.error}`, true);
            } else {
                // Generic error if no data or error received
                showNotification('Không nhận được dữ liệu clipboard.', true);
            }
        } catch (error) {
            // Handle errors communicating with the background script
            console.error("[CONTENT] Lỗi khi yêu cầu dữ liệu clipboard:", error);
            showNotification(`Lỗi kết nối extension: ${error.message}`, true);
        } finally {
            // Always reset the button state
            button.textContent = 'Autofill';
            button.disabled = false;
        }
    });
    return button;
}

// --- LOGIC PDFLIB (Tích hợp từ test script) ---

/** Chờ PDFLib sẵn sàng */
function loadPdfLibIfNotReady(timeout = 7000) {
    return new Promise((resolve, reject) => {
        if (typeof window.PDFLib !== 'undefined') {
            return resolve(window.PDFLib);
        }
        const startTime = Date.now();
        const interval = setInterval(() => {
            if (typeof window.PDFLib !== 'undefined') {
                clearInterval(interval);
                resolve(window.PDFLib);
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                reject(new Error(`PDFLib did not load within ${timeout}ms. Check manifest.json and ensure the library file is correct.`));
            }
        }, 250);
    });
}


/** Chụp PDF từ popup (ĐÃ CẬP NHẬT VỚI LOGIC CHỐNG LẶP BLOB) */
async function capturePdfFromPopup(rowIndex) {
    const dialogSelector = '#id_Image_Dialog';
    const iframeSelector = '#id_Image_Dialog_content';
    
    // Yêu cầu của bạn là 0.0005 giây (0.5ms). 
    // Trình duyệt thường sẽ làm tròn giá trị tối thiểu là 1ms.
    const POLLING_INTERVAL = 1; // 1ms (0.001 giây), nhanh nhất có thể để test
    const TOTAL_TIMEOUT = 10000; // 10 giây tổng thời gian chờ trước khi báo lỗi

    // 1. Chờ dialog và iframe xuất hiện (với DOM ban đầu)
    await waitForElement(dialogSelector, 10000);
    const iframe = await waitForElement(iframeSelector, 7000);
    if (!iframe) throw new Error("Không tìm thấy Iframe sau khi chờ.");

    const startTime = Date.now();

    // 2. Bắt đầu vòng lặp polling (dưới dạng Promise) để chờ blob MỚI
    return new Promise((resolve, reject) => {
        const pollForNewBlob = async () => {
            try {
                // Phải query lại iframe mỗi lần vì nó có thể bị re-render
                const currentIframe = document.querySelector(iframeSelector);

                if (!currentIframe) {
                    // Nếu iframe biến mất, đó là lỗi
                    return reject(new Error(`Iframe ${iframeSelector} đã biến mất trong lúc polling.`));
                }

                const pdfBlobUrl = currentIframe.src;

                // --- ĐIỀU KIỆN CHỜ ---
                // 1. Phải là blob
                const isValid = pdfBlobUrl && pdfBlobUrl.startsWith('blob:');
                // 2. Blob URL này CHƯA được xử lý (lấy từ Set toàn cục)
                const isNew = !processedBlobUrls.has(pdfBlobUrl);

                if (isValid && isNew) {
                    // TÌM THẤY BLOB MỚI
                    processedBlobUrls.add(pdfBlobUrl); // Đánh dấu đã xử lý URL này

                    // 3. Fetch dữ liệu
                    const response = await fetch(pdfBlobUrl);
                    if (!response.ok) {
                        throw new Error(`Lỗi fetch blob URL: ${response.statusText}`);
                    }
                    const pdfData = await response.arrayBuffer();
                    resolve(pdfData); // Hoàn thành Promise
                    return; // Thoát khỏi vòng lặp
                }

                // CHƯA THỎA MÃN (src=about:blank, src=blob:cũ, hoặc chưa load)
                if (Date.now() - startTime > TOTAL_TIMEOUT) {
                    // Hết thời gian chờ
                    let errorMsg = `Timeout: Không tìm thấy blob MỚI sau ${TOTAL_TIMEOUT / 1000}s.`;
                    if (isValid && !isNew) errorMsg += " (Lý do: Bị kẹt ở blob URL cũ).";
                    if (!isValid) errorMsg += " (Lý do: src không phải là blob, có thể là 'about:blank').";
                    return reject(new Error(errorMsg));
                }

                // Chờ và thử lại
                setTimeout(pollForNewBlob, POLLING_INTERVAL);
            } catch (err) {
                reject(err); // Báo lỗi nếu fetch/logic nội bộ bị hỏng
            }
        };

        // Bắt đầu poll lần đầu tiên
        pollForNewBlob();
    });
}


/** Ghép và tải PDF */

async function generateQrPdf() {

    if (capturedPdfData.size === 0) {

        showNotification("Không có PDF nào để ghép.", true);

        return;

    }



    const qrButton = document.getElementById('batch-qr-button'); // Find the button

    if (qrButton) qrButton.textContent = 'Đang ghép PDF...';



    try {

        const PDFLib = await loadPdfLibIfNotReady(7000);

        if (!PDFLib || typeof PDFLib.PDFDocument === 'undefined') {

             throw new Error("Đối tượng PDFLib không hợp lệ sau khi tải.");

        }

        const { PDFDocument } = PDFLib;

        const mergedPdf = await PDFDocument.create();



        let pageCount = 0;

        for (const [rowId, pdfBytes] of capturedPdfData.entries()) {

            try {

                const pdf = await PDFDocument.load(pdfBytes);

                const pageIndices = pdf.getPageIndices();

                const copiedPages = await mergedPdf.copyPages(pdf, pageIndices);

                copiedPages.forEach((page) => {

                    mergedPdf.addPage(page);

                    pageCount++;

                });

            } catch (loadError) {

                 console.error(`[Generate] Lỗi khi load hoặc sao chép trang từ PDF của row ID: ${rowId}`, loadError);

                 showNotification(`Lỗi xử lý 1 PDF: ${loadError.message}`, true);

            }

        }



        if (pageCount === 0) {

             throw new Error("Không thể thêm bất kỳ trang nào vào PDF cuối cùng.");

        }



        const mergedPdfBytes = await mergedPdf.save();

        const blob = new Blob([mergedPdfBytes], { type: 'application/pdf' });

        const link = document.createElement('a');

        link.href = URL.createObjectURL(blob);

        // Đặt tên file theo yêu cầu

        link.download = `QR_Weighbridge_${getFormattedDate('_')}.pdf`;

        document.body.appendChild(link);

        link.click();

        document.body.removeChild(link);

        URL.revokeObjectURL(link.href);

        showNotification(`Đã ghép ${pageCount} trang thành công!`, false);



    } catch (error) {

        console.error("[Generate] Lỗi nghiêm trọng trong quá trình ghép PDF:", error);

        showNotification("Lỗi khi ghép file PDF: " + error.message, true);

    } finally {

         if (qrButton) {

             qrButton.textContent = 'Tải tất cả QR'; // Đặt lại tên nút

         }

    }

}


/** Xử lý quét hàng loạt */
async function batchProcessAllRows() {
    if (isCapturing) return; // Prevent multiple clicks

    const tableBody = document.querySelector('tbody[id*="id_POTableDy-tblBody"]');
    if (!tableBody) {
        showNotification("Lỗi: Không tìm thấy bảng dữ liệu.", true);
        return;
    }

    const allPrintButtons = Array.from(tableBody.querySelectorAll('span.vn_wb_Print'));
    if (allPrintButtons.length === 0) {
        showNotification("Không tìm thấy nút in nào trong bảng.", true);
        return;
    }

    const qrButton = document.getElementById('batch-qr-button');
    if (qrButton) {
        qrButton.textContent = `Đang xử lý 0/${allPrintButtons.length}...`;
        qrButton.disabled = true;
    }

    capturedPdfData.clear();
    tickedRows.clear(); // Also clear manual ticks
    processedBlobUrls.clear(); // <-- THÊM MỚI: Dọn dẹp Set blob URL
    isCapturing = true; // Set capturing flag

    try {
        let count = 0;
        let successCount = 0;
        for (const printButton of allPrintButtons) {
            count++;
            const row = printButton.closest('tr');
            if (!row) continue;
            const rowId = row.id || `row-index-${count}`;

            row.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            row.style.setProperty('background-color', '#fff3cd', 'important');

            await new Promise(resolve => setTimeout(resolve, 0)); // Delay between clicks
            printButton.click();

            try {
                const pdfData = await capturePdfFromPopup(count);
                capturedPdfData.set(rowId, pdfData);
                tickedRows.add(rowId); // Mark as processed in the UI panel
                successCount++;
                 row.style.setProperty('background-color', '#d4edda', 'important');
                 redrawTickboxPanel(tableBody); // Update panel after each success

            } catch (error) {
                 console.error(`[Batch] Lỗi khi xử lý dòng ${count} (ID: ${rowId}):`, error);
                showNotification(`Lỗi xử lý dòng ${count}: ${error.message}`, true);
                row.style.setProperty('background-color', '#f8d7da', 'important');
                // Attempt to redraw panel even on error to show progress/failures
                redrawTickboxPanel(tableBody);
            } finally {
                if (qrButton) {
                    qrButton.textContent = `Đang xử lý ${count}/${allPrintButtons.length}...`;
                }
            }
        } // End for loop

        if (capturedPdfData.size > 0) {
            showNotification(`Đã xử lý ${count} dòng. Đang tạo PDF từ ${successCount} bản ghi thành công...`, false);
            await generateQrPdf(); // Call generate PDF
        } else {
            showNotification("Không thể trích xuất bất kỳ mã QR nào.", true);
        }

    } catch (error) {
        console.error("[Batch] Lỗi nghiêm trọng:", error);
        showNotification("Đã xảy ra lỗi không mong muốn: " + error.message, true);
    } finally {
        isCapturing = false; // Clear capturing flag
        if (qrButton) {
            qrButton.textContent = 'Tải tất cả QR'; // Reset button text
            qrButton.disabled = false; // Re-enable button
        }
         // Clear highlights after generation attempt
         setTimeout(() => {
             try {
                 tableBody?.querySelectorAll('tr[style*="background-color"]').forEach(r => r.style.removeProperty('background-color'));
                 tickedRows.clear(); // Clear ticks after process finishes
                 redrawTickboxPanel(tableBody); // Redraw empty panel state
             } catch(e) { /* Ignore minor cleanup errors */ }
         }, 3000);
    }
}


// --- CÁC HÀM XỬ LÝ GỐC (AUTOFILL, TICKBOX, POPUP...) ---


/** Tạo panel cho Goods Receipt (ĐÃ CẬP NHẬT) */
function createGoodsReceiptPanel() {
    // Check if the panel already exists
    if (document.getElementById('goods-receipt-panel')) return;

    // Create the main panel
    const panel = createFloatingPanel('goods-receipt-panel', 'Chức năng GR');
    const container = panel.querySelector('.panel-container');

    // === THÊM MỚI: Nút "Sửa data copy" ===
    const editButton = createEditDataButton();
    container.appendChild(editButton);
    // === KẾT THÚC THÊM MỚI ===

    // Existing Autofill button
    const autofillButton = createAutofillButton();
    container.appendChild(autofillButton);

    // Add the panel to the page
    document.body.appendChild(panel);
}

/** Khởi tạo tính năng cho Weigh Bridge Main */
function initWeighBridgeMainFeatures() {
    const tableBody = document.querySelector('tbody[id*="id_POTableDy-tblBody"]');
    if (!tableBody || tableBody.dataset.tickboxInitialized) return;

    tableBody.dataset.tickboxInitialized = 'true';
    tickedRows.clear();

    // Panel chính cho Weigh Bridge
    const panel = createFloatingPanel('weighbridge-panel', 'Chức năng WB');
    const container = panel.querySelector('.panel-container');

    // 1. Nút "Tải tất cả QR"
    const qrButton = document.createElement('button');
    qrButton.id = 'batch-qr-button';
    qrButton.textContent = 'Tải tất cả QR';
    Object.assign(qrButton.style, {
        padding: '8px 15px', backgroundColor: '#28a745', // Màu xanh lá
        color: 'white', border: 'none', borderRadius: '5px',
        cursor: 'pointer', fontSize: '14px', width: '100%'
    });
    qrButton.onclick = batchProcessAllRows;
    container.appendChild(qrButton);

    // === THÊM MỚI: Nút "Sửa data copy" ===
    const editButton = createEditDataButton();
    container.appendChild(editButton);
    // === KẾT THÚC THÊM MỚI ===

    // 3. Nút Autofill
    const autofillButton = createAutofillButton();
    container.appendChild(autofillButton);

    document.body.appendChild(panel); // Thêm panel vào trang

    const table = tableBody.closest('table');
    if (!table) return;

    const signal = abortController.signal;
    table.addEventListener('click', (event) => {
        if (isTableUpdating || isCapturing) return;
        // <-- ĐÃ XÓA CHỮ 'a' BỊ LỖI Ở ĐÂY
        const target = event.target;
        const deleteButton = target.closest('span.delimage');
        const copyButton = target.closest('button.CBtn');
        const addButton = target.closest('span.addimage');
        const printButton = target.closest('span.vn_wb_Print'); 

        if (printButton) {
            handlePrintClick(printButton);
        } else if (deleteButton || copyButton || addButton) {
            handleRowChange(deleteButton ? 'delete' : (copyButton ? 'copy' : 'add'), target, tableBody);
        }
    }, { signal });

    // Hiển thị panel tickbox ban đầu
    redrawTickboxPanel(tableBody);
}

// Giữ nguyên các hàm xử lý Autofill, popup PO, highlight,...
async function handleAutofill(clipboardData) {
    if (!clipboardData || clipboardData.length === 0) { showNotification("Dữ liệu clipboard rỗng hoặc không hợp lệ.", true); return; }
    switch (currentAppState) {
        case STATE_WEIGH_BRIDGE_MAIN: runWeighBridgeAutofill(clipboardData); break;
        case STATE_GOODS_RECEIPT: await runGoodsReceiptAutofill(clipboardData); break;
        default: showNotification('Không thể tự động điền ở màn hình này.', true); break;
    }
}

async function runGoodsReceiptAutofill(clipboardData) {
    const poElement = document.querySelector('input[id*="weighBridgeTableId-"][id$="-inner"]');
    const itemElement = document.querySelector('span[id^="__text"][id*="weighBridgeTableId-"]');

    if (!poElement || !itemElement) {
        showNotification("Lỗi: Không tìm thấy ô PO hoặc Item trên trang.", true);
        return;
    }

    const poValue = poElement.value;
    const itemValue = itemElement.textContent;

    if (!poValue || !itemValue) {
        showNotification("Lỗi: Ô PO hoặc Item trên trang không có giá trị.", true);
        return;
    }

    const pagePoNumber = poValue.trim();
    const pageItemNumber = parseInt(itemValue.trim(), 10);

    const matchingData = clipboardData.find(item => item.PO === pagePoNumber && parseInt(item.Item, 10) === pageItemNumber);

    if (matchingData) {
        // --- LOGIC THAY ĐỔI CHO BILL OF LANDING ---
        let billOfLandingValue = matchingData['B/L NO.']; // Lấy giá trị gốc

        // Kiểm tra xem giá trị có tồn tại và dài hơn 16 ký tự không
        if (billOfLandingValue && billOfLandingValue.length > 16) {
            billOfLandingValue = billOfLandingValue.substring(1); // Bỏ ký tự đầu tiên
            console.log("Bill of Landing > 16 chars, removed first char:", billOfLandingValue); // Log (có thể xóa sau)
        }
        // --- KẾT THÚC THAY ĐỔI ---

        // Điền dữ liệu vào form
        const didFillDeliveryNote = fillFioriInputBySelector('input[id*="deliveryNoteId-inner"]', getFormattedDate());
        // Sử dụng giá trị đã được điều chỉnh (nếu cần)
        const didFillBillOfLanding = fillFioriInputBySelector('input[id*="billLandingId-inner"]', billOfLandingValue);
        const didFillHeaderText = fillFioriInputBySelector('input[id*="headerTextId-inner"]', matchingData['CD No.']);

        // --- LOGIC MỚI CHO MANUF. DATE (CLICK CALENDAR TỰ ĐỘNG) ---
        
        // Dùng querySelectorAll để tìm TẤT CẢ các icon calendar trong các dòng
        const manufDateIcons = document.querySelectorAll('span[id^="__picker0-application-ZGTGRGI-display-component---worklist--weighBridgeTableId-"][id$="-icon"]');
        let allMfgDatesFilled = manufDateIcons.length > 0; // Bắt đầu bằng true nếu tìm thấy ít nhất 1 icon

        if (manufDateIcons.length === 0) {
            allMfgDatesFilled = false; // Đánh dấu false nếu không tìm thấy icon nào
        } else {
            // Phải dùng for...of để sử dụng await bên trong vòng lặp
            for (const iconElement of manufDateIcons) {
                // Kiểm tra xem icon còn trên trang không
                if (!document.body.contains(iconElement)) continue;

                try {
                    // 1. Click icon để mở calendar
                    iconElement.click();

                    // 2. Chờ popover (Timeout 500ms)
                    const popoverIdBase = iconElement.id.replace('-icon', '-RP-popover');
                    const popover = await waitForElement(`div[id="${popoverIdBase}"]`, 500); // <-- Giảm timeout

                    // 3. Chờ ô "hôm nay" (Timeout 500ms)
                    const todayDivCell = await waitForElement(`div[id="${popoverIdBase}"] div.sapUiCalItemNow`, 500); // <-- Giảm timeout

                    // 4. Click
                    dispatchRobustClick(todayDivCell);
                    
                    // 5. Chờ biến mất (Timeout 500ms)
                    await waitForElementToDisappear(`div[id="${popoverIdBase}"]`, 500); // <-- Giảm timeout
                    
                    // 6. Delay 0ms (chỉ để nhường quyền cho event loop)
                    await new Promise(resolve => setTimeout(resolve, 0)); // <-- GIẢM XUỐNG 0

                } catch (error) {
                    // Đã tắt log lỗi (từ bước trước)
                    // console.error("Lỗi khi auto-click calendar (robust/max-speed):", error, "cho icon:", iconElement.id);
                    allMfgDatesFilled = false;
                    
                    // Cố gắng đóng popover (logic cũ vẫn giữ)
                    try {
                        const openPopover = document.querySelector('div.sapMPopover[role="dialog"][id*="-RP-popover"]');
                        if (openPopover) {
                            openPopover.style.display = 'none';
                            // console.warn("Đã buộc ẩn popover bị kẹt.");
                        }
                    } catch (closeError) {
                        // console.error("Lỗi khi cố gắng đóng popover kẹt:", closeError);
                    }
                    
                    continue; // VẪN TIẾP TỤC VÒNG LẶP
                }
            }
        }
        // --- KẾT THÚC LOGIC MỚI ---

        if (didFillDeliveryNote && didFillBillOfLanding && didFillHeaderText && allMfgDatesFilled) { // <-- Đã thêm allMfgDatesFilled vào
            showNotification('Đã tự động điền dữ liệu Goods Receipt!', false);
        } else {
            // Thêm chi tiết lỗi
            let errorMsg = 'Lỗi điền form:';
            if (!didFillDeliveryNote) errorMsg += ' DeliveryNote';
            if (!didFillBillOfLanding) errorMsg += ' BillOfLanding';
            if (!didFillHeaderText) errorMsg += ' HeaderText';
            if (!allMfgDatesFilled) errorMsg += ' Manuf.Date'; // <-- Thêm chi tiết lỗi Manuf.Date
            showNotification(errorMsg, true);
        }
    } else {
        showNotification('Không tìm thấy dữ liệu khớp trong clipboard.', true);
    }
}

function runWeighBridgeAutofill(clipboardData) {
    // Attempt to find PO/Item in the first visible row, more robustly
    const firstRow = document.querySelector('tbody[id*="id_POTableDy-tblBody"] tr:first-child');
    if (!firstRow) { showNotification('Không tìm thấy hàng nào trong bảng PO.', true); return;}

    const firstRowPOInput = firstRow.querySelector('input[id*="Pono-"][id$="-inner"]');
    const firstRowItemInput = firstRow.querySelector('input[id*="idPOitemNo-"][id$="-inner"]');

    if (!firstRowPOInput || !firstRowItemInput) { showNotification('Không tìm thấy ô PO/Item ở dòng đầu tiên.', true); return; }

    const pagePoNumber = firstRowPOInput.value.trim();
    const pageItemNumber = parseInt(firstRowItemInput.value.trim(), 10);

    if (!pagePoNumber || isNaN(pageItemNumber)) { showNotification('Giá trị PO/Item ở dòng đầu không hợp lệ.', true); return; }

    const matchingData = clipboardData.find(item => item.PO === pagePoNumber && parseInt(item.Item, 10) === pageItemNumber);
    if (matchingData) {
        const originalContainerNo = matchingData["Container No."];
        // Kiểm tra nếu giá trị tồn tại, là string, và có thể gọi hàm substring
        const processedContainerNo = (originalContainerNo && typeof originalContainerNo.substring === 'function') 
            ? originalContainerNo.substring(4) // Lấy chuỗi con từ vị trí thứ 4 (bỏ qua 4 ký tự đầu)
            : originalContainerNo; // Giữ nguyên giá trị gốc nếu không hợp lệ
        
        fillFioriInputBySelector('#CONTNO-inner', processedContainerNo);
        fillFioriInputBySelector('#REMARK-inner', matchingData.Supplier);
	  fillFioriInputBySelector('#CHALLAN-inner', matchingData['LOT NO.']);
        showNotification('Đã tự động điền dữ liệu Weigh Bridge!', false);
    } else { showNotification('Không tìm thấy dữ liệu khớp trong clipboard cho dòng đầu tiên.', true); }
}


function initWeighBridgeDialogFeatures(searchInput) {
    searchInput.setAttribute('data-extension-listener-attached', 'true');
    const signal = abortController.signal;

    // Click listener for showing PO dropdown
    searchInput.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (currentDropdown && document.body.contains(currentDropdown)) {
            currentDropdown.remove();
            currentDropdown = null;
            return;
        }
        const loadingDropdown = createPoDropdown(null, searchInput, true);
        document.body.appendChild(loadingDropdown);
        currentDropdown = loadingDropdown;
        updateDropdownPosition(searchInput, loadingDropdown);

        try {
            const response = await chrome.runtime.sendMessage({ type: "REQUEST_CLIPBOARD_DATA" });
             // Check if dropdown still exists before removing/replacing
            if (currentDropdown === loadingDropdown && document.body.contains(loadingDropdown)) {
                loadingDropdown.remove();
            } else {
                 return; // Dropdown was closed or changed
            }
             // Ensure search input is still valid before proceeding
            if (!document.body.contains(searchInput)) return;

            const dataDropdown = createPoDropdown(response?.data, searchInput, false);
            document.body.appendChild(dataDropdown);
            currentDropdown = dataDropdown;
            updateDropdownPosition(searchInput, dataDropdown);

        } catch (error) {
            console.warn("Lỗi kết nối extension:", error);
            if (currentDropdown === loadingDropdown && document.body.contains(loadingDropdown)) {
                 const errorItem = loadingDropdown.querySelector('div');
                 if (errorItem) errorItem.textContent = 'Lỗi kết nối. Thử lại.';
                setTimeout(() => {
                    if (currentDropdown === loadingDropdown && document.body.contains(loadingDropdown)) {
                         loadingDropdown.remove();
                         currentDropdown = null;
                    }
                }, 2500);
            }
        }
    }, { signal });

    // Input listener to clear highlights
    searchInput.addEventListener('input', () => { clearAllHighlights(); }, { signal });

    // Reset button listener
    const form = searchInput.closest('form');
    const resetButton = form?.querySelector('div[id*="searchField-reset"]');
    if (resetButton && !resetButton.dataset.extensionListenerAttached) {
         resetButton.setAttribute('data-extension-listener-attached', 'true');
         resetButton.addEventListener('click', () => { clearAllHighlights(); }, { signal });
    }

     // Close dropdown if clicking outside
     document.body.addEventListener('click', (event) => {
        if (currentDropdown && !currentDropdown.contains(event.target) && event.target !== searchInput) {
            currentDropdown.remove();
            currentDropdown = null;
        }
     }, { signal, capture: true }); // Use capture to catch clicks early
}

function createPoDropdown(data, searchInput, isLoading) {
    const dropdown = document.createElement('div');
    Object.assign(dropdown.style, {
        position: 'fixed', backgroundColor: 'white', border: '1px solid #ccc',
        borderRadius: '4px', zIndex: '99999', maxHeight: '200px',
        overflowY: 'auto', boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
        fontSize: '14px'
    });

    if (isLoading) {
        const itemEl = document.createElement('div'); // Renamed variable
        itemEl.textContent = 'Đang đọc clipboard...';
        itemEl.style.padding = '8px 12px';
        dropdown.appendChild(itemEl);
    } else if (!Array.isArray(data) || data.length === 0) {
        const itemEl = document.createElement('div');
        itemEl.textContent = 'Clipboard rỗng hoặc không hợp lệ';
        itemEl.style.padding = '8px 12px';
        dropdown.appendChild(itemEl);
         setTimeout(() => { /* Auto-close logic unchanged */ }, 2500);
    } else {
        // **THAY ĐỔI:** Lặp qua TẤT CẢ data (không tạo uniquePOs nữa)
        data.forEach(item => {
            const option = document.createElement('div');
            // **THAY ĐỔI:** Hiển thị cả PO và Item
            option.textContent = `PO: ${item.PO} - Item: ${item.Item}`;
            Object.assign(option.style, {
                padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #eee',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            });
            // Tooltip vẫn giữ nguyên để hiện Supplier nếu có
            option.title = `PO: ${item.PO}, Item: ${item.Item}, Supplier: ${item.Supplier || 'N/A'}`;
            option.onmouseenter = () => { option.style.backgroundColor = '#f0f0f0'; };
            option.onmouseleave = () => { option.style.backgroundColor = 'white'; };
            option.onclick = () => {
                fillFioriInputBySelector('input[id*="searchField-I"]', item.PO);
                if(currentDropdown) currentDropdown.remove();
                currentDropdown = null;

                const searchButton = document.querySelector('div[id*="searchField-search"]');
                if (searchButton) searchButton.click();

                // Chỉ highlight dòng được chọn
                setTimeout(() => {
                    clearAllHighlights(); // Clear previous highlights first
                    highlightTableRow(item.PO, item.Item);
                }, 800);
            };
            dropdown.appendChild(option);
        });
        if(dropdown.lastChild) dropdown.lastChild.style.borderBottom = 'none';
    }
    return dropdown;
}

function clearAllHighlights() {
    document.querySelectorAll('tr.autofill-highlight').forEach(row => {
        row.classList.remove('autofill-highlight');
        row.style.removeProperty('background-color'); // Use removeProperty
    });
}

function highlightTableRow(po, item) {
    // Don't clear here, allow multiple highlights for the same PO
    const rows = document.querySelectorAll('div[role="dialog"] tbody tr');
    const itemToMatch = String(item).padStart(5, '0'); // PO Item is often 5 digits

    for (const row of rows) {
        // Skip already highlighted rows to avoid style conflicts if called multiple times
        if (row.classList.contains('autofill-highlight')) continue;

        const cells = row.querySelectorAll('td');
        if (cells.length > 2) { // Assuming PO is in cell 1, Item in cell 2 (0-based index)
            const poSpan = cells[1].querySelector('span[id*="-txt"]'); // Adjust index if needed
            const itemSpan = cells[2].querySelector('span[id*="-txt"]'); // Adjust index if needed

            if (poSpan && itemSpan &&
                poSpan.textContent.trim() === po &&
                itemSpan.textContent.trim() === itemToMatch) {
                row.style.setProperty('background-color', '#d4edda', 'important'); // Green highlight
                row.classList.add('autofill-highlight');
                // Don't break, continue to highlight all matching items for the PO
            }
        }
    }
}

// Logic tick thủ công khi click nút in
function handlePrintClick(printButton) {
    if (isTableUpdating || isCapturing) return; // Prevent action if busy
    const row = printButton.closest('tr');
    if (row && row.id) { // Ensure row and row.id exist
        // **THAY ĐỔI:** Toggle tick state
        tickedRows.add(row.id); // Always add (or keep) the row ID in the set
         // Cập nhật UI ngay lập tức
         redrawTickboxPanel(row.closest('tbody'));
    } else {
        console.warn("Could not find row or row ID for print button:", printButton);
    }
}


function handleRowChange(action, target, tableBody) {
    // Check flags to prevent conflicts
    if (isTableUpdating || isCapturing) return;
    isTableUpdating = true;

    // --- LOGIC FROM ORIGINAL SCRIPT ---
    const clickedRow = (action !== 'add') ? target.closest('tr') : null;
    const allRowsBefore = Array.from(tableBody.children);
    // Determine index based on the row clicked, or end of list if adding
    const clickedIndex = clickedRow ? allRowsBefore.indexOf(clickedRow) : allRowsBefore.length;
    // Create a boolean map of the ticked state *before* the change, based on current IDs
    const beforeTickedState = allRowsBefore.map(row => tickedRows.has(row.id));

    // Wait for Fiori to update the DOM
    setTimeout(() => {
        const newRows = Array.from(tableBody.querySelectorAll('tr')); // Get rows *after* the change
        let intermediateTickedState = [...beforeTickedState]; // Copy the boolean map

        // Adjust the boolean map based on the action and index where it occurred
        if (action === 'delete' && clickedIndex !== -1) {
            intermediateTickedState.splice(clickedIndex, 1); // Remove state at deleted index
        } else if (action === 'copy' && clickedIndex !== -1) {
             // Insert 'false' (unticked) state for the newly copied row after the original
            intermediateTickedState.splice(clickedIndex + 1, 0, false);
        } else if (action === 'add') {
            intermediateTickedState.push(false); // Add 'false' state for the new row at the end
        }

        // Rebuild the tickedRows Set using the adjusted boolean map and the NEW row IDs
        const newTickedRows = new Set();
        newRows.forEach((row, index) => {
            // If the boolean map says this position should be ticked...
            if (intermediateTickedState[index] === true && row.id) { // Ensure row.id exists
                newTickedRows.add(row.id); // ...add the NEW ID of the row at this position
            }
        });

        tickedRows = newTickedRows; // Update the main Set
        redrawTickboxPanel(tableBody); // Redraw the panel with correct states
        isTableUpdating = false;
    }, 500); // Keep 500ms delay for stability
}

// Hàm vẽ lại panel tickbox (được gọi bởi handlePrintClick, handleRowChange, batchProcessAllRows)
function redrawTickboxPanel(tableBody) {
    // Tìm panel theo ID mới
    const panel = document.getElementById('weighbridge-panel');
    if (!panel) return;
    const container = panel.querySelector('.panel-container');
    if (!container) return;

    // Tìm hoặc tạo khu vực dành riêng cho tickbox list
    let tickboxList = container.querySelector('.tickbox-list');
    if (!tickboxList) {
        tickboxList = document.createElement('div');
        tickboxList.className = 'tickbox-list';
        Object.assign(tickboxList.style, {
            maxHeight: '200px', // Giới hạn chiều cao
            overflowY: 'auto', // Thêm thanh cuộn nếu cần
             borderTop: '1px solid #eee', // Phân tách với nút
             paddingTop: '8px', // Khoảng cách
             marginTop: '8px' // Khoảng cách
        });
        // Chèn list vào đầu container (trên nút Autofill và QR)
        container.insertBefore(tickboxList, container.firstChild);
    }

    tickboxList.innerHTML = ''; // Xóa nội dung cũ

    if (!tableBody) return; // Thoát nếu tableBody không hợp lệ

    const rows = tableBody.querySelectorAll('tr');
    rows.forEach((row, index) => {
        const itemDiv = document.createElement('div');
        Object.assign(itemDiv.style, { display: 'flex', alignItems: 'center', marginBottom: '5px' });

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `tickbox-row-${row.id || index}`; // Use row.id if available
        checkbox.style.marginRight = '8px';
        checkbox.style.pointerEvents = 'none'; // Chỉ để hiển thị

        // Cố gắng lấy số thứ tự từ input trong cột đầu tiên (index 0)
        const siNoInput = row.cells[0]?.querySelector('input[id*="-inner"]');
        const rowNumberText = siNoInput ? siNoInput.value.trim() || `${index + 1}` : `${index + 1}`; // Lấy giá trị hoặc dùng index

        const label = document.createElement('label');
        label.setAttribute('for', checkbox.id);
        label.textContent = `Dòng ${rowNumberText}`;
        label.style.cursor = 'pointer';
        label.style.fontSize = '13px'; // Kích thước nhỏ hơn chút

        label.onclick = (e) => {
            e.preventDefault(); // Ngăn hành vi mặc định của label
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };

        // Highlight row based on tickedRows Set
        if (tickedRows.has(row.id)) {
            checkbox.checked = true;
            row.style.setProperty('background-color', '#cfe2ff', 'important'); // Blue highlight for manual tick
            row.classList.add('print-highlight');
        } else {
            checkbox.checked = false;
            // Only remove background if it wasn't set by batch process
            if (row.classList.contains('print-highlight') && !row.style.backgroundColor?.includes('rgb(212, 237, 218)') && !row.style.backgroundColor?.includes('rgb(248, 215, 218)')) {
                row.style.removeProperty('background-color');
                row.classList.remove('print-highlight');
            }
        }

        itemDiv.appendChild(checkbox);
        itemDiv.appendChild(label);
        tickboxList.appendChild(itemDiv);
    });
}


function updateDropdownPosition(searchInput, dropdown) {
     if (!searchInput || !dropdown) return;
    const rect = searchInput.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom + window.scrollY + 2}px`; // Add scrollY
    dropdown.style.left = `${rect.left + window.scrollX}px`;   // Add scrollX
    dropdown.style.width = `${rect.width}px`;
}