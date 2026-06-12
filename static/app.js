function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
}
const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.setAttribute('data-theme', savedTheme);

let allImages = [];
let currentIndex = 0;
let offset = 0;
const limit = 30;
let loading = false;
let hasMore = true;
let debounceTimer;
const pendingUploads = new Set();

let activeAuthCallback = null;

const gallery = document.getElementById('gallery');
const loadingIndicator = document.getElementById('loading-indicator');

let scale = 1;
let startScale = 1;
let startDistance = 0;
let isDragging = false;
let startX = 0, startY = 0;
let translateX = 0, translateY = 0;

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const img = entry.target;
            img.src = img.dataset.src;
            img.onload = () => { img.classList.add('loaded'); };
            observer.unobserve(img);
        }
    });
});

function requestActionAuthorization(callbackAction) {
    const rememberedPassword = sessionStorage.getItem('gallery_session_pwd');
    if (rememberedPassword) {
        callbackAction(rememberedPassword);
        return;
    }
    activeAuthCallback = callbackAction;
    
    // This will now safely work because auth-modal exists in the HTML before execution!
    document.getElementById('auth-modal').style.display = 'flex';
    document.getElementById('auth-password-field').focus();
}

function closeAuthModal() {
    document.getElementById('auth-modal').style.display = 'none';
    document.getElementById('auth-password-field').value = '';
    activeAuthCallback = null;
}


function submitAuthModal() {
    const pwd = document.getElementById('auth-password-field').value;
    if (!pwd) return;
    
    sessionStorage.setItem('gallery_session_pwd', pwd);
    const actionToRun = activeAuthCallback;
    closeAuthModal();
    
    if (actionToRun) actionToRun(pwd);
}

// Custom "Are You Sure?" Modal Controllers
function closeConfirmModal() {
    document.getElementById('confirm-modal').style.display = 'none';
}

function submitConfirmModal() {
    closeConfirmModal();
    // Proceed with password check, then deletion
    requestActionAuthorization((password) => {
        executeDeletion(password);
    });
}

// 🔄 Workflow Step 1: Triggered when pressing the '+' FAB button
function triggerUploadCheck() {
    // 1. Verify password session authorization first
    requestActionAuthorization(() => {
        const mainSelector = document.getElementById('album-select');
        const uploadSelector = document.getElementById('upload-select-existing');
        
        // 2. Clear old options and synchronize current list
        uploadSelector.innerHTML = '<option value="">📁 General Gallery / No Album</option><option value="__NEW_ALBUM__">➕ [Create New Album / Category...]</option>';
        
        Array.from(mainSelector.options).forEach(opt => {
            if (opt.value !== 'all') {
                const newOpt = document.createElement('option');
                newOpt.value = opt.value;
                newOpt.innerText = opt.innerText;
                uploadSelector.appendChild(newOpt);
            }
        });

        // 3. Reveal the Album option window cleanly
        document.getElementById('upload-new-album-input').style.display = 'none';
        document.getElementById('upload-new-album-input').value = '';
        document.getElementById('upload-album-modal').style.display = 'flex';
    });
}

function closeUploadAlbumModal() {
    document.getElementById('upload-album-modal').style.display = 'none';
}

function triggerDeleteCheck(event) {
    if (event) event.stopPropagation();
    // Opens custom confirmation panel instead of standard browser alert prompt
    document.getElementById('confirm-modal').style.display = 'flex';
}

function triggerFilterReset() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        allImages = [];
        offset = 0;
        hasMore = true;
        gallery.innerHTML = '';
        loadImages();
    }, 300);
}

function renderGalleryHTML() {
    gallery.innerHTML = '';
    allImages.forEach((name, imgIndex) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.onclick = () => openModal(imgIndex);

        const cleanBase = name.substring(0, name.lastIndexOf('.'));
        const thumbFilename = cleanBase + '.webp';

        card.innerHTML = `
            <div class="thumb-container">
                <img data-src="/thumb/${thumbFilename}" alt="${name}">
            </div>
            <div class="file-name">${name.replace(/^\d+_/, '')}</div>
        `;

        gallery.appendChild(card);
        const imgElement = card.querySelector('img');
        observer.observe(imgElement);
    });
}




function handleUpload(input) {
    if (!input.files || input.files.length === 0) return;
    const password = sessionStorage.getItem('gallery_session_pwd');
    const file = input.files[0];

    const formData = new FormData();
    formData.append('password', password);
    formData.append('album', globalSelectedUploadAlbum); 
    formData.append('image', file); 

    // ⚡ INSTANT BACKGROUND PROCESSING:
    // We add the file to your tracking set right away
    pendingUploads.add(file.name);
    
    // We flash a quick confirmation toast or console message instead of freezing the screen
    console.log(`Started background upload for: ${file.name}`);

    // 🔥 THE CRITICAL CHANGE: 
    // We remove 'await' and don't assign fetch to a variable. 
    // This shoots the request to your Rust server and immediately moves to the next line of code!
    fetch('/api/upload', { method: 'POST', body: formData })
        .then(async (response) => {
            if (response.ok) {
                pendingUploads.delete(file.name);
                // Refresh the toolbar dropdown options quietly in the background
                loadAlbumDropdownOptions();
            } else if (response.status === 401) {
                alert("Background upload failed: Unauthorized. Please check your password.");
                sessionStorage.removeItem('gallery_session_pwd');
            } else {
                const errorText = await response.text();
                console.error("Background upload error details:", errorText);
            }
        })
        .catch((err) => {
            console.error("Network error during background transfer:", err);
        });

    // ⚡ INSTANT EXIT:
    // The input field resets and control returns to you immediately. 
    // Your WebSocket system will automatically trigger `triggerFilterReset()` to display the image when it's ready!
    input.value = ''; 
}






async function executeDeletion(password) {
    const currentFilename = allImages[currentIndex];
    if (!currentFilename) return;

    try {
        const response = await fetch('/api/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: currentFilename, password: password })
        });

        if (response.ok) {
            allImages.splice(currentIndex, 1);
            offset = Math.max(0, offset - 1);
            renderGalleryHTML();

            if (allImages.length > 0) {
                openModal(currentIndex >= allImages.length ? 0 : currentIndex);
            } else {
                closeModal();
            }
        } else if (response.status === 401) {
            alert("Unauthorized: Incorrect password.");
            sessionStorage.removeItem('gallery_session_pwd');
        } else {
            const errorText = await response.text();
            alert("Deletion failed: " + errorText);
        }
    } catch (err) {
        console.error("Error deleting image:", err);
        alert("Network error processing deletion request.");
    }
}

function createCardElement(name, imgIndex) {
    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => openModal(imgIndex);
    card.innerHTML = `
        <div class="thumb-container">
            <img data-src="/thumb/${name.substring(0, name.lastIndexOf('.'))}.webp" alt="${name}">
        </div>
        <div class="file-name">${name.replace(/^\d+_/, '')}</div>
    `;
    return card;
}



// 🔄 Update your loadImages function to pass the selected album filter value to the server:
async function loadImages() {
    if (loading || !hasMore) return;
    loading = true;
    loadingIndicator.style.display = 'block';

    const search = document.getElementById('search-input').value;
    const sort = document.getElementById('sort-select').value;
    const sizeValue = document.getElementById('size-select').value;
    const albumValue = document.getElementById('album-select').value; // 🆕 Fetch option state

    let extraParams = '';
    if (albumValue !== 'all') extraParams += `&album=${encodeURIComponent(albumValue)}`;
    if (sizeValue === 'small') extraParams += '&max_size=1048576';
    else if (sizeValue === 'medium') extraParams += '&min_size=1048576&max_size=5242880';
    else if (sizeValue === 'large') extraParams += '&min_size=5242880';

    try {
        const url = `/api/images?offset=${offset}&limit=${limit}&search=${encodeURIComponent(search)}&sort=${sort}${extraParams}`;
        const response = await fetch(url);
        const data = await response.json();

        data.images.forEach((name) => {
            const imgIndex = allImages.length;
            allImages.push(name);
            const card = createCardElement(name, imgIndex);
            gallery.appendChild(card);
            observer.observe(card.querySelector('img'));
        });

        offset += data.images.length;
        hasMore = data.has_more;
    } catch (err) {
        console.error(err);
    } finally {
        loading = false;
        loadingIndicator.style.display = 'none';
    }
}



let globalSelectedUploadAlbum = ""; 

// 🆕 Toggles the input field display box if the user chooses the "[Create New Album...]" select action item
function toggleNewAlbumInputField(selectElement) {
    const inputField = document.getElementById('upload-new-album-input');
    if (selectElement.value === '__NEW_ALBUM__') {
        inputField.style.display = 'block';
        inputField.focus();
    } else {
        inputField.style.display = 'none';
        inputField.value = '';
    }
}

// 🔄 Intercepts the click action FAB to open our beautiful custom overlay menu modal configuration block
function triggerUploadCheck() {
    requestActionAuthorization(() => {
        // Build and populate the upload dialog selection options based on existing albums list
        const mainSelector = document.getElementById('album-select');
        const uploadSelector = document.getElementById('upload-select-existing');
        
        // Synchronize dropdown profiles elements 
        uploadSelector.innerHTML = '<option value="">📁 General Gallery / No Album</option><option value="__NEW_ALBUM__">➕ [Create New Album / Category...]</option>';
        
        // Grab existing album collections parsed directly out of our sidebar main layout selector filters list
        Array.from(mainSelector.options).forEach(opt => {
            if (opt.value !== 'all') {
                const newOpt = document.createElement('option');
                newOpt.value = opt.value;
                newOpt.innerText = opt.innerText;
                uploadSelector.appendChild(newOpt);
            }
        });

        // Open the custom selection modal interface
        document.getElementById('upload-new-album-input').style.display = 'none';
        document.getElementById('upload-new-album-input').value = '';
        document.getElementById('upload-album-modal').style.display = 'flex';
    });
}

function closeUploadAlbumModal() {
    document.getElementById('upload-album-modal').style.display = 'none';
}

// 🔄 Workflow Step 2: Triggered when clicking "Next: Choose File"
function submitUploadAlbumModal() {
    const selectVal = document.getElementById('upload-select-existing').value;
    const inputVal = document.getElementById('upload-new-album-input').value.trim();

    if (selectVal === '__NEW_ALBUM__') {
        if (!inputVal) {
            alert("Please type a name for your new album!");
            return;
        }
        globalSelectedUploadAlbum = inputVal;
    } else {
        globalSelectedUploadAlbum = selectVal;
    }

    closeUploadAlbumModal();
    // Open native browser file selector input
    document.getElementById('file-input').click();
}



// 🔄 Update loadAlbumDropdownOptions to ensure the upload options list refreshes automatically
async function loadAlbumDropdownOptions() {
    try {
        const response = await fetch('/api/albums');
        if (response.ok) {
            const data = await response.json();
            const selector = document.getElementById('album-select');
            
            selector.innerHTML = '<option value="all">📁 All Albums / General</option>';
            
            data.albums.forEach(albumName => {
                const opt = document.createElement('option');
                opt.value = albumName;
                opt.innerText = `📂 ${albumName}`;
                selector.appendChild(opt);
            });
        }
    } catch (err) {
        console.error("Error refreshing active data category choices lists:", err);
    }
}









window.onscroll = () => {
    if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 800) {
        loadImages();
    }
};

function updateTransform() {
    const modalImg = document.getElementById('modal-img');
    if (modalImg) {
        modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    }
}

function openModal(imgIndex) {
    currentIndex = imgIndex;
    const name = allImages[currentIndex];
    if (!name) return;

    const container = document.getElementById('modal-container');
    const modalImg = document.getElementById('modal-img');

    if (!container || !modalImg) return;

    scale = 1; translateX = 0; translateY = 0;
    modalImg.style.transform = 'translate(0px, 0px) scale(1)';
    modalImg.src = `/images/${name}`;
    container.style.display = 'block';
}

function closeModal() {
    const container = document.getElementById('modal-container');
    const modalImg = document.getElementById('modal-img');
    if (container) container.style.display = 'none';
    if (modalImg) modalImg.src = '';
}

function closeModalTarget(event) {
    if (event.target.id === 'modal-container' || event.target.className === 'panzoom-wrapper') {
        closeModal();
    }
}

function nextImage(event) {
    if (event) event.stopPropagation();
    openModal((currentIndex + 1) >= allImages.length ? 0 : currentIndex + 1);
}

function prevImage(event) {
    if (event) event.stopPropagation();
    openModal((currentIndex - 1) < 0 ? allImages.length - 1 : currentIndex - 1);
}

const wrapper = document.querySelector('.panzoom-wrapper');
wrapper.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = 0.15;
    if (e.deltaY < 0) scale = Math.min(scale + zoomFactor, 6);
    else {
        scale = Math.max(scale - zoomFactor, 1);
        if (scale === 1) { translateX = 0; translateY = 0; }
    }
    updateTransform();
}, { passive: false });

wrapper.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
        isDragging = true;
        startX = e.touches[0].clientX - translateX;
        startY = e.touches[0].clientY - translateY;
    } else if (e.touches.length === 2) {
        isDragging = false;
        startScale = scale;
        startDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
}, { passive: true });

wrapper.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && isDragging && scale > 1) {
        translateX = e.touches[0].clientX - startX;
        translateY = e.touches[0].clientY - startY;
        updateTransform();
    } else if (e.touches.length === 2) {
        const currentDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        scale = Math.max(1, Math.min(startScale * (currentDistance / startDistance), 6));
        if (scale === 1) { translateX = 0; translateY = 0; }
        updateTransform();
    }
}, { passive: true });

wrapper.addEventListener('touchend', () => { isDragging = false; });
wrapper.addEventListener('mousedown', (e) => {
    if (scale > 1 && e.button === 0) {
        isDragging = true;
        wrapper.style.cursor = 'grabbing';
        startX = e.clientX - translateX;
        startY = e.clientY - translateY;
    }
});

window.addEventListener('mousemove', (e) => {
    if (isDragging && scale > 1) {
        translateX = e.clientX - startX;
        translateY = e.clientY - startY;
        updateTransform();
    }
});
window.addEventListener('mouseup', () => { if (isDragging) { isDragging = false; wrapper.style.cursor = 'default'; } });

function setupWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${wsProtocol}//${window.location.host}/api/ws`);
    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const originalNameFromWebsocket = data.filename.replace(/^\d+_/, '');
            if (allImages.includes(data.filename) || pendingUploads.has(originalNameFromWebsocket)) {
                pendingUploads.delete(originalNameFromWebsocket);
                return;
            }
            allImages.unshift(data.filename);
            offset += 1;
            renderGalleryHTML();
        } catch (err) { console.error(err); }
    };
    socket.onclose = () => { setTimeout(() => { setupWebSocket(); }, 2000); };
}
function forgetPassword() {
    if (sessionStorage.getItem('gallery_session_pwd')) {
        sessionStorage.removeItem('gallery_session_pwd');
        alert("Session cleared! Admin actions are now locked.");
    } else {
        alert("No password is currently saved in this session.");
    }
}



// Call dropdown parsing on startup execution line loop near bottom of file:
loadAlbumDropdownOptions();
setupWebSocket();
loadImages();