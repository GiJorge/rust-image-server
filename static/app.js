function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
}
const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.setAttribute('data-theme', savedTheme);

// --- Core State Variables ---
let allImages = [];
let currentIndex = 0;
let offset = 0;
const limit = 30;
let loading = false;
let hasMore = true;
let debounceTimer;
const pendingUploads = new Set();

// Side tracking object mapping image files to their albums
let imageAlbumMap = {}; 
let globalSelectedUploadAlbum = ""; 
let globalAssignPasswordStorage = ""; 
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

// --- Delete Modal Functions ---
function triggerDeleteCheck(event) {
    if (event) event.stopPropagation();
    document.getElementById('confirm-modal').style.display = 'flex';
}

function closeConfirmModal() {
    document.getElementById('confirm-modal').style.display = 'none';
}

function submitConfirmModal() {
    closeConfirmModal();
    requestActionAuthorization((password) => {
        executeDeletion(password);
    });
}

// --- Existing Images Album Assignment Functions ---
function triggerExistingAlbumAssign(event) {
    if (event) event.stopPropagation();
    
    requestActionAuthorization((password) => {
        globalAssignPasswordStorage = password;
        
        const currentFilename = allImages[currentIndex];
        const currentAlbum = imageAlbumMap[currentFilename] || "";

        const mainSelector = document.getElementById('album-select');
        const assignSelector = document.getElementById('assign-select-existing');
        
        assignSelector.innerHTML = '<option value="">📁 General Gallery / No Album</option><option value="__NEW_ALBUM__">➕ [Create New Album...]</option>';
        
        Array.from(mainSelector.options).forEach(opt => {
            if (opt.value !== 'all' && opt.value !== '') {
                const newOpt = document.createElement('option');
                newOpt.value = opt.value;
                newOpt.innerText = opt.innerText;
                assignSelector.appendChild(newOpt);
            }
        });

        assignSelector.value = currentAlbum;
        document.getElementById('assign-new-album-input').style.display = 'none';
        document.getElementById('assign-new-album-input').value = '';
        document.getElementById('assign-existing-album-modal').style.display = 'flex';
    });
}

function closeAssignAlbumModal() {
    document.getElementById('assign-existing-album-modal').style.display = 'none';
}

function toggleExistingNewAlbumInputField(selectElement) {
    const inputField = document.getElementById('assign-new-album-input');
    if (selectElement.value === '__NEW_ALBUM__') {
        inputField.style.display = 'block';
        inputField.focus();
    } else {
        inputField.style.display = 'none';
        inputField.value = '';
    }
}

async function submitExistingAlbumAssign() {
    const currentFilename = allImages[currentIndex];
    const selectVal = document.getElementById('assign-select-existing').value;
    const inputVal = document.getElementById('assign-new-album-input').value.trim();

    let targetAlbum = selectVal === '__NEW_ALBUM__' ? inputVal : selectVal;

    if (selectVal === '__NEW_ALBUM__' && !targetAlbum) {
        alert("Please specify an album name.");
        return;
    }

    try {
        const response = await fetch('/api/images/assign_album', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: currentFilename,
                album: targetAlbum,
                password: globalAssignPasswordStorage
            })
        });

        if (response.ok) {
            imageAlbumMap[currentFilename] = targetAlbum;
            closeAssignAlbumModal();
            await loadAlbumDropdownOptions();
            triggerFilterReset();
        } else {
            alert("Failed to assign album: " + await response.text());
        }
    } catch (err) {
        console.error("Network configuration fault:", err);
    }
}

// --- Upload Workflow Modals ---
function triggerUploadCheck() {
    requestActionAuthorization(() => {
        const mainSelector = document.getElementById('album-select');
        const uploadSelector = document.getElementById('upload-select-existing');
        
        uploadSelector.innerHTML = '<option value="">📁 General Gallery / No Album</option><option value="__NEW_ALBUM__">➕ [Create New Album / Category...]</option>';
        
        Array.from(mainSelector.options).forEach(opt => {
            if (opt.value !== 'all' && opt.value !== '') {
                const newOpt = document.createElement('option');
                newOpt.value = opt.value;
                newOpt.innerText = opt.innerText;
                uploadSelector.appendChild(newOpt);
            }
        });

        document.getElementById('upload-new-album-input').style.display = 'none';
        document.getElementById('upload-new-album-input').value = '';
        document.getElementById('upload-album-modal').style.display = 'flex';
    });
}

function closeUploadAlbumModal() {
    document.getElementById('upload-album-modal').style.display = 'none';
}

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
    document.getElementById('file-input').click();
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

// --- Card Engine (Uses arrow events to eliminate quotes clashing) ---
function createCardElement(name, imgIndex) {
    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => openModal(imgIndex);

    const cleanBase = name.includes('.') ? name.substring(0, name.lastIndexOf('.')) : name;
    const thumbFilename = cleanBase + '.jpg';
    
    // 🎯 Read the album string on the fly for this card
    const albumName = imageAlbumMap[name] || "";
    
    // Create the badge HTML element string if an album tag exists
    const albumBadgeHtml = albumName 
        ? `<div class="image-album-badge">📂 ${albumName}</div>` 
        : '';

    card.innerHTML = `
        <div class="thumb-container">
            ${albumBadgeHtml}
            <img src="" 
                 data-src="/thumb/${thumbFilename}" 
                 alt="Gallery Preview Thumbnail"
                 style="width: 100%; height: 100%; object-fit: cover; display: block;"
                 onerror="this.onerror = null; if(this.src.endsWith('.jpg')) { this.src = '/thumb/${cleanBase}.webp'; }">
        </div>
        <div class="file-name">${name.replace(/^\d+_/, '')}</div>
    `;
    return card;
}

function renderGalleryHTML() {
    gallery.innerHTML = '';
    allImages.forEach((name, imgIndex) => {
        const card = createCardElement(name, imgIndex);
        gallery.appendChild(card);
        observer.observe(card.querySelector('img'));
    });
}

// --- Data Fetching and Persistence Operations ---

async function loadImages() {
    if (loading || !hasMore) return;
    loading = true;
    loadingIndicator.style.display = 'block';

    const search = document.getElementById('search-input').value;
    const sort = document.getElementById('sort-select').value;
    const sizeValue = document.getElementById('size-select').value;
    const albumValue = document.getElementById('album-select').value;

    let extraParams = '';
    if (albumValue !== 'all') extraParams += `&album=${encodeURIComponent(albumValue)}`;
    
    if (sizeValue === 'small') {
        extraParams += '&max_size=1048576';
    } else if (sizeValue === 'medium') {
        extraParams += '&min_size=1048576&max_size=5242880';
    } else if (sizeValue === 'large') {
        extraParams += '&min_size=5242880';
    }

    try {
        const url = `/api/images?offset=${offset}&limit=${limit}&search=${encodeURIComponent(search)}&sort=${sort}${extraParams}`;
        const response = await fetch(url);
        const data = await response.json();

        // ⚙️ Process objects containing both filename and album data
        data.images.forEach((imgObj) => {
            const name = imgObj.filename;
            const albumName = imgObj.album;

            const imgIndex = allImages.length;
            allImages.push(name);
            
            // 🎯 Map the correct album from the database directly into the local state
            imageAlbumMap[name] = albumName;

            const card = createCardElement(name, imgIndex);
            gallery.appendChild(card);
            observer.observe(card.querySelector('img'));
        });

        offset += data.images.length;
        hasMore = data.has_more;
    } catch (err) {
        console.error("Failed to load images batch chunk:", err);
    } finally {
        loading = false;
        loadingIndicator.style.display = 'none';
    }
}

function handleUpload(input) {
    if (!input.files || input.files.length === 0) return;
    const password = sessionStorage.getItem('gallery_session_pwd');
    const file = input.files[0];

    // 🆕 Bring up the visual loading window spinner overlay instantly
    document.getElementById('loading-overlay').style.display = 'flex';
    document.getElementById('upload-status').innerText = "Processing image & generating thumbnail...";

    const formData = new FormData();
    formData.append('password', password);
    formData.append('album', globalSelectedUploadAlbum); 
    formData.append('image', file); 

    pendingUploads.add(file.name);

    fetch('/api/upload', { method: 'POST', body: formData })
        .then(async (response) => {
            // 🆕 Dismiss the upload loading animation mask instantly when complete
            document.getElementById('loading-overlay').style.display = 'none';
            
            if (response.ok) {
                pendingUploads.delete(file.name);
                loadAlbumDropdownOptions();
            } else if (response.status === 401) {
                alert("Upload unauthorized. Resetting session credentials.");
                sessionStorage.removeItem('gallery_session_pwd');
            } else {
                alert("Upload failed: " + await response.text());
            }
        })
        .catch((err) => {
            // 🆕 Auto-dismiss on network disconnect dropouts
            document.getElementById('loading-overlay').style.display = 'none';
            console.error("Network infrastructure error during streaming:", err);
        });

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
            delete imageAlbumMap[currentFilename];
            allImages.splice(currentIndex, 1);
            renderGalleryHTML();

            if (allImages.length > 0) {
                openModal(currentIndex >= allImages.length ? 0 : currentIndex);
            } else {
                closeModal();
            }
        } else {
            alert("Deletion failure.");
        }
    } catch (err) { console.error(err); }
}



async function loadAlbumDropdownOptions() {
    try {
        const response = await fetch('/api/albums');
        if (response.ok) {
            const data = await response.json();
            const selector = document.getElementById('album-select');
            
            // Remember what the user was looking at before updating options
            const currentSelected = selector.value;
            
            selector.innerHTML = '<option value="all">📁 All Albums / General</option><option value="">📁 General Gallery / No Album</option>';
            
            data.albums.forEach(albumName => {
                if (albumName.trim() !== "") {
                    const opt = document.createElement('option');
                    opt.value = albumName;
                    opt.innerText = `📂 ${albumName}`;
                    selector.appendChild(opt);
                }
            });
            
            // Restore selection cleanly
            selector.value = currentSelected;
        }
    } catch (err) { 
        console.error("Could not sync category select controls:", err); 
    }
}



// --- WebSocket Live Stream Sync Handling ---
// 🔄 Keep this sync function clean and lightweight inside static/app.js
function setupWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${wsProtocol}//${window.location.host}/api/ws`);
    
    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            // 🎯 1. LIVE DELETION CHECK
            if (data.action === 'delete') {
                const targetFilename = data.filename;
                
                // Remove from our main image listing cache array
                const imageIndex = allImages.indexOf(targetFilename);
                if (imageIndex > -1) {
                    allImages.splice(imageIndex, 1);
                    if (offset > 0) offset -= 1;
                }

                // Remove from the album tracking memory map
                delete imageAlbumMap[targetFilename];

                // Re-render the gallery layout so the deleted card vanishes smoothly
                renderGalleryHTML();
                
                // Refresh the album dropdown lists in case it was the last file in that album
                loadAlbumDropdownOptions();
                return; // Stop processing further for a deletion
            }

            // --- 📥 2. YOUR EXISTING UPLOAD / MOVE LOGIC ---
            const incomingFile = data.filename;
            const incomingAlbum = data.album || ""; 
            const originalNameFromWebsocket = incomingFile.replace(/^\d+_/, '');
            
            // Clear pending tracking flags
            pendingUploads.delete(originalNameFromWebsocket);

            // Save the album tracking state globally in frontend memory
            imageAlbumMap[incomingFile] = incomingAlbum;
            
            const activeAlbumFilter = document.getElementById('album-select').value;
            const imageIndex = allImages.indexOf(incomingFile);

            // FILTER MATCH: Does this item belong in our current layout filter?
            const matchesFilter = (
                activeAlbumFilter === 'all' || 
                (activeAlbumFilter === '' && incomingAlbum === '') || 
                (activeAlbumFilter === incomingAlbum)
            );

            if (imageIndex > -1) {
                // The image is already on our screen! Let's verify it still belongs here.
                if (!matchesFilter) {
                    // It was moved to an album we aren't viewing right now, remove it dynamically.
                    allImages.splice(imageIndex, 1);
                    if (offset > 0) offset -= 1;
                    renderGalleryHTML();
                }
            } else {
                // This is a brand new upload item coming in
                if (matchesFilter) {
                    allImages.unshift(incomingFile);
                    offset += 1;
                    renderGalleryHTML();
                }
            }
            
            // Refresh our drop-down list variables so new album tags show up instantly!
            loadAlbumDropdownOptions();

        } catch (err) { 
            console.error("Real-time pipeline refresh error:", err); 
        }
    };
    
    socket.onclose = () => { setTimeout(setupWebSocket, 3000); };
}




// --- Image Carousel Lightbox Functions ---
function updateTransform() {
    const modalImg = document.getElementById('modal-img');
    if (modalImg) modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
}

function openModal(imgIndex) {
    currentIndex = imgIndex;
    const name = allImages[currentIndex];
    if (!name) return;

    const container = document.getElementById('modal-container');
    const modalImg = document.getElementById('modal-img');

    scale = 1; translateX = 0; translateY = 0;
    modalImg.style.transform = 'translate(0px, 0px) scale(1)';
    modalImg.src = `/images/${name}`;
    container.style.display = 'block';
}

function closeModal() {
    document.getElementById('modal-container').style.display = 'none';
    document.getElementById('modal-img').src = '';
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

// --- Window Scroll Pagination ---
window.onscroll = () => {
    if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 800) {
        loadImages();
    }
};

// --- Gesture Mapping Event Hook Handlers ---
const wrapper = document.querySelector('.panzoom-wrapper');
wrapper.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.deltaY < 0) scale = Math.min(scale + 0.15, 6);
    else { scale = Math.max(scale - 0.15, 1); if (scale === 1) { translateX = 0; translateY = 0; } }
    updateTransform();
}, { passive: false });

wrapper.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) { isDragging = true; startX = e.touches[0].clientX - translateX; startY = e.touches[0].clientY - translateY; }
    else if (e.touches.length === 2) { isDragging = false; startScale = scale; startDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }
}, { passive: true });

wrapper.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && isDragging && scale > 1) { translateX = e.touches[0].clientX - startX; translateY = e.touches[0].clientY - startY; updateTransform(); }
    else if (e.touches.length === 2) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        scale = Math.max(1, Math.min(startScale * (dist / startDistance), 6));
        if (scale === 1) { translateX = 0; translateY = 0; }
        updateTransform();
    }
}, { passive: true });

wrapper.addEventListener('touchend', () => { isDragging = false; });
wrapper.addEventListener('mousedown', (e) => { if (scale > 1 && e.button === 0) { isDragging = true; wrapper.style.cursor = 'grabbing'; startX = e.clientX - translateX; startY = e.clientY - translateY; } });
window.addEventListener('mousemove', (e) => { if (isDragging && scale > 1) { translateX = e.clientX - startX; translateY = e.clientY - startY; updateTransform(); } });
window.addEventListener('mouseup', () => { if (isDragging) { isDragging = false; wrapper.style.cursor = 'default'; } });

function forgetPassword() {
    sessionStorage.removeItem('gallery_session_pwd');
    alert("Session cleared.");
}

//loadAlbumDropdownOptions();
//setupWebSocket();
//loadImages();


async function bootAppWithVanityRouting() {
    // 1. Rebuild the options list from the backend database categories
    await loadAlbumDropdownOptions();
    
    // 2. Extract the address URL path parameter
    const pathParts = window.location.pathname.split('/');
    const urlAlbum = pathParts[1] && pathParts[1] !== "" ? decodeURIComponent(pathParts[1]) : "all";

    // Ensure we are looking at a real album name, not a system resource asset
    if (urlAlbum !== "all" && urlAlbum !== "static" && urlAlbum !== "api" && urlAlbum !== "images" && urlAlbum !== "thumb") {
        const albumSelect = document.getElementById('album-select');
        if (albumSelect) {
            
            // 🎯 CASE-INSENSITIVE CHECK: 
            // Turn everything lowercase to find a match, regardless of how the user typed it
            const targetLower = urlAlbum.toLowerCase();
            let matchedOptionValue = null;

            for (let i = 0; i < albumSelect.options.length; i++) {
                if (albumSelect.options[i].value.toLowerCase() === targetLower) {
                    // Found a match! Capture the exact case string expected by your Rust backend database
                    matchedOptionValue = albumSelect.options[i].value;
                    break;
                }
            }

            // If the matching folder exists in your dropdown, use its exact database string casing style
            if (matchedOptionValue !== null) {
                albumSelect.value = matchedOptionValue;
            } else {
                // If it's a completely fresh shared album link space with no files yet,
                // fall back to using the exact string provided in the URL path address text
                const opt = document.createElement('option');
                opt.value = urlAlbum;
                opt.innerText = `📂 ${urlAlbum}`;
                albumSelect.appendChild(opt);
                albumSelect.value = urlAlbum;
            }
        }
    }
    
    // 3. Fetch data array grids from backend API routes
    await loadImages();
    
    // 4. Fire up your persistent WebSocket listener
    setupWebSocket();
}

// Execute the final synchronized startup routine!
bootAppWithVanityRouting();