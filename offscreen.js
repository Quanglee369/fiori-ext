// offscreen.js

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // --- Block 1: Xử lý ĐỌC clipboard ---
  if (message.type === 'GET_CLIPBOARD_FROM_OFFSCREEN') {
    console.log("[OFFSCREEN] Đã nhận được yêu cầu GET_CLIPBOARD_FROM_OFFSCREEN.");
    const textarea = document.getElementById('clipboard-helper');
    if (!textarea) {
      console.error("[OFFSCREEN] Lỗi: không tìm thấy textarea.");
      sendResponse({ error: 'Không tìm thấy thẻ textarea trong offscreen.html' });
      return false; // Return false để không giữ kênh mở không cần thiết
    }

    textarea.value = '';
    textarea.focus();

    try {
      const success = document.execCommand('paste');
      if (success) {
        console.log("[OFFSCREEN] Dán thành công. Gửi lại dữ liệu:", textarea.value.substring(0, 50) + "...");
        sendResponse({ data: textarea.value });
      } else {
        console.error("[OFFSCREEN] Lỗi: execCommand('paste') thất bại.");
        sendResponse({ error: 'Không thể thực thi lệnh "paste".' });
      }
    } catch (e) {
      console.error("[OFFSCREEN] Lỗi nghiêm trọng khi thực thi execCommand('paste'):", e);
      sendResponse({ error: e.message });
    }
    // Không cần return true ở đây vì sendResponse đã được gọi đồng bộ
    return false;
  } // <-- Dấu ngoặc nhọn đóng của khối IF đầu tiên

  // --- Block 2: Xử lý GHI clipboard ---
  // else if phải nằm ngay sau dấu } của if trên
  else if (message.type === 'WRITE_CLIPBOARD_TO_OFFSCREEN') {
    console.log("[OFFSCREEN] Đã nhận được yêu cầu WRITE_CLIPBOARD_TO_OFFSCREEN.");
    const textarea = document.getElementById('clipboard-helper');
    if (!textarea) {
      console.error("[OFFSCREEN] Lỗi: không tìm thấy textarea.");
      sendResponse({ success: false, error: 'Không tìm thấy thẻ textarea trong offscreen.html' });
      return false; // Return false
    }

    textarea.value = message.data; // Gán dữ liệu mới vào
    textarea.select(); // Chọn toàn bộ

    try {
      const success = document.execCommand('copy'); // Thực thi lệnh COPY
      if (success) {
        console.log("[OFFSCREEN] Copy thành công.");
        sendResponse({ success: true });
      } else {
        console.error("[OFFSCREEN] Lỗi: execCommand('copy') thất bại.");
        sendResponse({ success: false, error: 'Không thể thực thi lệnh "copy".' });
      }
    } catch (e) {
      console.error("[OFFSCREEN] Lỗi nghiêm trọng khi thực thi execCommand('copy'):", e);
      sendResponse({ success: false, error: e.message });
    }
    // Không cần return true ở đây
    return false;
  } // <-- Dấu ngoặc nhọn đóng của khối ELSE IF

  // Optional: Xử lý các loại message khác nếu có
  // else {
  //   console.log("[OFFSCREEN] Nhận được message không xác định:", message.type);
  // }

  // Nếu không phải là message cần xử lý bất đồng bộ, bạn có thể return false
  // Hoặc nếu có khả năng xử lý bất đồng bộ khác, return true và gọi sendResponse sau
  // Trong trường hợp này, không còn xử lý nào khác nên có thể bỏ qua return
}); // <-- Dấu ngoặc tròn và ngoặc nhọn đóng của addListener