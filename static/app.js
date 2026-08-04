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
let globalManifest = []; // Holds all image filenames from server
let currentIndex = 0;
let currentAbortController = null;
let navDebounceTimer = null;
let offset = 0;
const limit = 30;
let loading = false;
let hasMore = true;
let debounceTimer;
let wsRenderTimeout;
let albumRefreshTimer;
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


// Fetch image list from Rust backend
async function initManifest() {
    try {
        const response = await fetch('/api/images/manifest');
        if (response.ok) {
            globalManifest = await response.json();
            console.log(`✅ Manifest loaded: ${globalManifest.length} images`);
        } else {
            console.error('❌ Manifest route error:', response.status);
        }
    } catch (err) {
        console.error('❌ Failed to fetch manifest:', err);
    }
}

// 2. Helper function to refresh counter text




function updateCounterDisplay() {
    const counterElem = document.getElementById('lightbox-counter');
    if (!counterElem) return;

    if (!allImages || allImages.length === 0) {
        counterElem.textContent = "0 / 0";
    } else {
        counterElem.textContent = `${currentIndex + 1} / ${allImages.length}`;
    }
}

// 3. Call updateCounterDisplay inside loadLightboxImage
function loadLightboxImage(index) {
    const filename = globalManifest[index];
    if (!filename) return;

    // Update counter on top of screen
    updateCounterDisplay();

    const imgElement = document.getElementById('modal-img');
    const spinner = document.getElementById('lightbox-spinner');

    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();

    if (spinner) spinner.classList.remove('hidden');

    const cleanStem = filename.includes('.') 
        ? filename.substring(0, filename.lastIndexOf('.')) 
        : filename;

    const thumbUrl = `/thumb/${cleanStem}.jpg`;
    const fullResUrl = `/images/${filename}`;

    // Force memory release on Samsung A06
    imgElement.src = '';
    imgElement.src = thumbUrl;

    const highResImg = new Image();
    highResImg.src = fullResUrl;

    const handleSuccess = () => {
        if (currentIndex === index) {
            imgElement.src = fullResUrl;
            if (spinner) spinner.classList.add('hidden');
        }
    };

    const handleError = () => {
        if (currentIndex === index) {
            if (spinner) spinner.classList.add('hidden');
        }
    };

    if ('decode' in highResImg) {
        highResImg.decode().then(handleSuccess).catch(handleError);
    } else {
        highResImg.onload = handleSuccess;
        highResImg.onerror = handleError;
    }
}

// Call on startup
document.addEventListener('DOMContentLoaded', () => {
    initManifest();
});

// --- Performance Helper Utilities ---
function scheduleGalleryRender() {
    clearTimeout(wsRenderTimeout);
    wsRenderTimeout = setTimeout(() => {
        renderGalleryHTML();
    }, 50);
}

function debouncedLoadAlbumOptions() {
    clearTimeout(albumRefreshTimer);
    albumRefreshTimer = setTimeout(() => {
        loadAlbumDropdownOptions();
    }, 300);
}

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
    const modal = document.getElementById('auth-modal');
    const input = document.getElementById('auth-password-field');
    
    if (modal) modal.style.display = 'none';
    if (input) input.value = '';

    // If modal was closed without successful auth, resolve with null
    if (authModalResolver) {
        authModalResolver(null);
        authModalResolver = null;
    }
}

async function submitAuthModal() {
    const input = document.getElementById('auth-password-field');
    const password = input ? input.value.trim() : '';

    if (!password) {
        alert("Password cannot be empty.");
        return;
    }

    // Verify entered password against Axum backend
    const isValid = await checkPasswordWithServer(password);

    if (isValid) {
        sessionStorage.setItem('gallery_session_pwd', password);
        closeAuthModal();
        if (authModalResolver) authModalResolver(password);
    } else {
        alert("❌ Incorrect master password. Please try again.");
        if (input) {
            input.value = '';
            input.focus();
        }
    }
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

    const fileInput = document.getElementById('file-input');
    if (fileInput) {
        fileInput.value = '';
        fileInput.multiple = true;
        fileInput.click();
    }
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

// --- Card Engine ---
function createCardElement(name, imgIndex) {
    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => openModal(imgIndex);

    // 💡 Extract clean stem without extension to target the generated thumbnail
    const cleanBase = name.includes('.') ? name.substring(0, name.lastIndexOf('.')) : name;
    
    // Server generates a .jpg thumbnail with clean stem regardless of media extension (.mov, .mp4, .png, etc.)
    const thumbFilename = cleanBase + '.jpg';
    const albumName = imageAlbumMap[name] || "";

    const albumBadgeHtml = albumName
        ? `<div class="image-album-badge">📂 ${albumName}</div>`
        : '';

    // 🎬 Video badge overlay (triggers for .mov, .mp4, .webm, .mkv, .avi)
    const videoBadgeHtml = isVideoFile(name)
        ? `<div class="video-badge" title="Video File">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            <span>VIDEO</span>
           </div>`
        : '';

    // Display clean name without initial timestamp prefix (e.g., 1718000000_my_video.mov -> my_video.mov)
    const displayName = name.replace(/^\d+_/, '');

    card.innerHTML = `
        <div class="thumb-container" style="position: relative;">
            ${albumBadgeHtml}
            ${videoBadgeHtml}
            <img src=""
                 data-src="/thumb/${encodeURIComponent(thumbFilename)}"
                 alt="${displayName}"
                 style="width: 100%; height: 100%; object-fit: cover; display: block;"
                 onerror="this.onerror = null; this.src='/images/${encodeURIComponent(name)}';">
        </div>
        <div class="file-name">${displayName}</div>
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

// --- Data Fetching and Multi-Upload Handler ---
async function loadImages() {
    if (loading || !hasMore) return;
    
    // 💡 Safely reference the DOM element
    const indicator = document.getElementById('loading-indicator') || loadingIndicator;

    loading = true;
    if (indicator) {
        indicator.style.display = 'block';
    }

    const search = document.getElementById('search-input')?.value || '';
    const sort = document.getElementById('sort-select')?.value || 'newest';
    const sizeValue = document.getElementById('size-select')?.value || 'all';
    const albumValue = document.getElementById('album-select')?.value || 'all';

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

        data.images.forEach((imgObj) => {
            const name = imgObj.filename;
            const albumName = imgObj.album;

            const imgIndex = allImages.length;
            allImages.push(name);
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
        
        // 💡 Null-safe display hide
        if (indicator) {
            indicator.style.display = 'none';
        }

        updateLoadMoreButtonState();

        if (hasMore && document.body.offsetHeight <= window.innerHeight) {
            loadImages();
        }
    }
}

async function loadImages() {
    if (loading || !hasMore) return;
    
    // 💡 Safely reference the DOM element
    const indicator = document.getElementById('loading-indicator') || loadingIndicator;

    loading = true;
    if (indicator) {
        indicator.style.display = 'block';
    }

    const search = document.getElementById('search-input')?.value || '';
    const sort = document.getElementById('sort-select')?.value || 'newest';
    const sizeValue = document.getElementById('size-select')?.value || 'all';
    const albumValue = document.getElementById('album-select')?.value || 'all';

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

        data.images.forEach((imgObj) => {
            const name = imgObj.filename;
            const albumName = imgObj.album;

            const imgIndex = allImages.length;
            allImages.push(name);
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
        
        // 💡 Null-safe display hide
        if (indicator) {
            indicator.style.display = 'none';
        }

        updateLoadMoreButtonState();

        if (hasMore && document.body.offsetHeight <= window.innerHeight) {
            loadImages();
        }
    }
}async function loadImages() {
    if (loading || !hasMore) return;
    
    // 💡 Safely reference the DOM element
    const indicator = document.getElementById('loading-indicator') || loadingIndicator;

    loading = true;
    if (indicator) {
        indicator.style.display = 'block';
    }

    const search = document.getElementById('search-input')?.value || '';
    const sort = document.getElementById('sort-select')?.value || 'newest';
    const sizeValue = document.getElementById('size-select')?.value || 'all';
    const albumValue = document.getElementById('album-select')?.value || 'all';

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

        data.images.forEach((imgObj) => {
            const name = imgObj.filename;
            const albumName = imgObj.album;

            const imgIndex = allImages.length;
            allImages.push(name);
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
        
        // 💡 Null-safe display hide
        if (indicator) {
            indicator.style.display = 'none';
        }

        updateLoadMoreButtonState();

        if (hasMore && document.body.offsetHeight <= window.innerHeight) {
            loadImages();
        }
    }
}async function loadImages() {
    if (loading || !hasMore) return;
    
    // 💡 Safely reference the DOM element
    const indicator = document.getElementById('loading-indicator') || loadingIndicator;

    loading = true;
    if (indicator) {
        indicator.style.display = 'block';
    }

    const search = document.getElementById('search-input')?.value || '';
    const sort = document.getElementById('sort-select')?.value || 'newest';
    const sizeValue = document.getElementById('size-select')?.value || 'all';
    const albumValue = document.getElementById('album-select')?.value || 'all';

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

        data.images.forEach((imgObj) => {
            const name = imgObj.filename;
            const albumName = imgObj.album;

            const imgIndex = allImages.length;
            allImages.push(name);
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
        
        // 💡 Null-safe display hide
        if (indicator) {
            indicator.style.display = 'none';
        }

        updateLoadMoreButtonState();

        if (hasMore && document.body.offsetHeight <= window.innerHeight) {
            loadImages();
        }
    }
}

// 💡 Helper to show/hide the button container
function updateLoadMoreButtonState() {
    const btnContainer = document.getElementById('load-more-container');
    if (!btnContainer) return;

    if (hasMore) {
        btnContainer.style.display = 'flex'; // Use flex to match your CSS alignment
    } else {
        btnContainer.style.display = 'none';
    }
}



let totalBatchCount = 0;
let processedBatchCount = 0;

// 💡 200 MB limit in bytes
const MAX_UPLOAD_LIMIT_BYTES = 200 * 1024 * 1024;

async function handleUpload(input) {
    if (!input.files || input.files.length === 0) return;

    // Validate password BEFORE running any file processing
    const password = await getOrVerifyMasterPassword();
    if (!password) {
        input.value = '';
        return; // Canceled or failed auth
    }

    const files = Array.from(input.files);

    // Pre-upload file size check
    const oversizedFiles = files.filter(f => f.size > MAX_UPLOAD_LIMIT_BYTES);
    if (oversizedFiles.length > 0) {
        const fileListStr = oversizedFiles
            .map(f => `• ${f.name} (${(f.size / (1024 * 1024)).toFixed(1)} MB)`)
            .join('\n');

        alert(`⚠️ Upload canceled:\nThe following file(s) exceed the limit:\n\n${fileListStr}`);
        input.value = '';
        return;
    }

    const formData = new FormData();
    formData.append('password', password);
    formData.append('album', typeof globalSelectedUploadAlbum !== 'undefined' ? (globalSelectedUploadAlbum || '') : '');

    files.forEach(file => {
        formData.append('image', file);
        pendingUploads.add(file.name);
    });

    totalBatchCount = files.length;
    processedBatchCount = 0;

    const progressContainer = document.getElementById('upload-progress-container');
    const progressText = document.getElementById('upload-progress-text');
    const progressPercent = document.getElementById('upload-progress-percent');
    const progressBarFill = document.getElementById('upload-progress-bar-fill');

    if (progressText) progressText.innerText = `Uploading ${files.length} file(s)...`;
    if (progressPercent) progressPercent.innerText = '0%';
    if (progressBarFill) progressBarFill.style.width = '0%';
    if (progressContainer) {
        progressContainer.style.display = 'block';
        progressContainer.style.opacity = '1';
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);

    xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && totalBatchCount > 0) {
            const uploadPercent = Math.round((event.loaded / event.total) * 50);
            if (progressBarFill) progressBarFill.style.width = uploadPercent + '%';
            if (progressPercent) progressPercent.innerText = uploadPercent + '%';
            
            if (uploadPercent >= 50 && progressText) {
                progressText.innerText = `Processing thumbnails (0/${totalBatchCount})...`;
            }
        }
    };

    xhr.onload = () => {
        if (xhr.status === 200) {
            files.forEach(file => pendingUploads.delete(file.name));
        } else if (xhr.status === 401) {
            files.forEach(file => pendingUploads.delete(file.name));
            sessionStorage.removeItem('gallery_session_pwd');
            alert("Upload unauthorized. Session expired or reset.");
            if (progressContainer) progressContainer.style.display = 'none';
        } else if (xhr.status === 413) {
            files.forEach(file => pendingUploads.delete(file.name));
            alert("Upload failed: Total payload exceeds server limit.");
            if (progressContainer) progressContainer.style.display = 'none';
        } else {
            files.forEach(file => pendingUploads.delete(file.name));
            alert("Upload failed: " + (xhr.responseText || `Server status ${xhr.status}`));
            if (progressContainer) progressContainer.style.display = 'none';
        }
    };

    xhr.onerror = () => {
        files.forEach(file => pendingUploads.delete(file.name));
        alert("Network transmission error occurred during upload.");
        if (progressContainer) progressContainer.style.display = 'none';
    };

    xhr.send(formData);
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


// 1. Global state for active album selection
//let currentActiveAlbum = 'all';

async function loadAlbumDropdownOptions() {
    try {
        const response = await fetch('/api/albums');
        if (response.ok) {
            const data = await response.json();
            const selector = document.getElementById('album-select');
            
            // Save currently selected value before updating DOM options
            const currentSelected = selector.value || 'all';

            selector.innerHTML = '<option value="all">📁 All Albums / General</option><option value="">📁 General Gallery / No Album</option>';

            data.albums.forEach(albumName => {
                if (albumName && albumName.trim() !== "") {
                    const opt = document.createElement('option');
                    opt.value = albumName;
                    opt.innerText = `📂 ${albumName}`;
                    selector.appendChild(opt);
                }
            });

            // Restore selection
            selector.value = currentSelected;
            currentActiveAlbum = selector.value;

            // 💡 Ensure event listener is attached once to trigger filtering
            if (!selector.dataset.listenerAttached) {
                selector.addEventListener('change', onAlbumFilterChange);
                selector.dataset.listenerAttached = "true";
            }
        }
    } catch (err) {
        console.error("Could not sync category select controls:", err);
    }
}

// 2. Event handler when dropdown value changes
async function onAlbumFilterChange(e) {
    currentActiveAlbum = e.target.value;
    console.log(`📁 Filtering gallery by album: "${currentActiveAlbum}"`);

    // Reset pagination state
    allImages = [];
    currentIndex = 0;

    // Clear grid UI container before loading filtered batch
    const galleryGrid = document.getElementById('gallery-grid') || document.getElementById('images-container');
    if (galleryGrid) galleryGrid.innerHTML = '';

    // Fetch page 1 for the selected album
    await fetchNextPageOfImages();
}

// 3. Updated fetch function that sends the album parameter to Axum
async function fetchNextPageOfImages() {
    if (loading || !hasMore) return 0;

    const currentOffset = allImages.length;
    const search = document.getElementById('search-input')?.value || '';
    const sort = document.getElementById('sort-select')?.value || 'newest';
    const sizeValue = document.getElementById('size-select')?.value || 'all';

    let extraParams = '';
    if (currentActiveAlbum && currentActiveAlbum !== 'all') {
        extraParams += `&album=${encodeURIComponent(currentActiveAlbum)}`;
    }
    if (sizeValue === 'small') extraParams += '&max_size=1048576';
    else if (sizeValue === 'medium') extraParams += '&min_size=1048576&max_size=5242880';
    else if (sizeValue === 'large') extraParams += '&min_size=5242880';

    const url = `/api/images?offset=${currentOffset}&limit=${limit}&search=${encodeURIComponent(search)}&sort=${sort}${extraParams}`;

    loading = true;
    try {
        const response = await fetch(url);
        if (!response.ok) return 0;

        const data = await response.json();
        const incomingImages = data.images || [];

        incomingImages.forEach((imgObj) => {
            if (!allImages.includes(imgObj.filename)) {
                allImages.push(imgObj.filename);
                imageAlbumMap[imgObj.filename] = imgObj.album;

                // Append card to gallery UI seamlessly
                const card = createCardElement(imgObj.filename, allImages.length - 1);
                gallery.appendChild(card);
                observer.observe(card.querySelector('img'));
            }
        });

        offset = allImages.length;
        hasMore = data.has_more;
        updateLoadMoreButtonState();

        return incomingImages.length;
    } catch (err) {
        console.error("❌ Failed fetching pagination batch:", err);
        return 0;
    } finally {
        loading = false;
    }
}

// --- Optimized WebSocket Live Stream Sync Handling ---
function setupWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${wsProtocol}//${window.location.host}/api/ws`);

   // Inside setupWebSocket():
socket.onmessage = (event) => {
    try {
        const data = JSON.parse(event.data);

        // --- Handle Upload Progress Updates via WebSockets ---
        if (data.action === 'upload' && totalBatchCount > 0) {
            processedBatchCount += 1;

            const progressContainer = document.getElementById('upload-progress-container');
            const progressText = document.getElementById('upload-progress-text');
            const progressPercent = document.getElementById('upload-progress-percent');
            const progressBarFill = document.getElementById('upload-progress-bar-fill');

            // Calculate overall completion (50% transfer + 50% server processing)
            const overallPercent = 50 + Math.round((processedBatchCount / totalBatchCount) * 50);
            
            progressBarFill.style.width = overallPercent + '%';
            progressPercent.innerText = overallPercent + '%';
            progressText.innerText = `Processing thumbnails (${processedBatchCount}/${totalBatchCount})...`;

            // When all thumbnails in batch finish processing
            if (processedBatchCount >= totalBatchCount) {
                progressText.innerText = 'All photos processed!';
                progressBarFill.style.width = '100%';
                progressPercent.innerText = '100%';

                // Reset counters
                totalBatchCount = 0;
                processedBatchCount = 0;

                // Hide progress bar smoothly
                setTimeout(() => {
                    progressContainer.style.opacity = '0';
                    setTimeout(() => { progressContainer.style.display = 'none'; }, 300);
                }, 2000);
            }
        }

        // Rest of your existing websocket logic...
        if (data.action === 'delete') {
            const targetFilename = data.filename;
            const imageIndex = allImages.indexOf(targetFilename);
            if (imageIndex > -1) {
                allImages.splice(imageIndex, 1);
                if (offset > 0) offset -= 1;
            }
            delete imageAlbumMap[targetFilename];
            scheduleGalleryRender();
            debouncedLoadAlbumOptions();
            return;
        }

        const incomingFile = data.filename;
        const incomingAlbum = data.album || "";
        const originalNameFromWebsocket = incomingFile.replace(/^\d+_/, '');

        pendingUploads.delete(originalNameFromWebsocket);
        imageAlbumMap[incomingFile] = incomingAlbum;

        const activeAlbumFilter = document.getElementById('album-select').value;
        const imageIndex = allImages.indexOf(incomingFile);

        const matchesFilter = (
            activeAlbumFilter === 'all' ||
            (activeAlbumFilter === '' && incomingAlbum === '') ||
            (activeAlbumFilter === incomingAlbum)
        );

        if (imageIndex > -1) {
            if (!matchesFilter) {
                allImages.splice(imageIndex, 1);
                if (offset > 0) offset -= 1;
                scheduleGalleryRender();
            }
        } else {
            if (matchesFilter) {
                allImages.unshift(incomingFile);
                offset += 1;

                const modalContainer = document.getElementById('modal-container');
                if (modalContainer && modalContainer.style.display === 'block') {
                    currentIndex += 1;
                }

                scheduleGalleryRender();
            }
        }

        debouncedLoadAlbumOptions();

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

// Open Modal at specific index
function openModal(index) {
    if (!allImages || allImages.length === 0) return;
    currentIndex = index;

    const modal = document.getElementById('modal-container');
    modal.style.display = 'flex';

    // 🔒 LOCK BODY SCROLLING
    document.body.classList.add('modal-open');

    loadLightboxImage(currentIndex);
    
    // Attach keyboard event listener
    window.addEventListener('keydown', handleKeyPress);
}
// Close Modal
// Close Modal
function closeModal() {
    const modal = document.getElementById('modal-container');
    
    // 🎬 STOP AUDIO & VIDEO PLAYBACK
    const videoElement = modal ? modal.querySelector('video') : null;
    if (videoElement) {
        videoElement.pause();
        videoElement.src = '';
        videoElement.load(); // Forces browser to immediately drop memory buffer & audio track
    }

    modal.style.display = 'none';

    // 🔓 UNLOCK BODY SCROLLING
    document.body.classList.remove('modal-open');

    // Reset pan/zoom state
    resetPanZoom();

    if (currentAbortController) {
        currentAbortController.abort();
    }

    window.removeEventListener('keydown', handleKeyPress);
}




// Target-based click closing (for clicking background overlay)
function closeModalTarget(event) {
    if (event.target.id === 'modal-container') {
        closeModal();
    }
}

let isTransitioning = false;



function nextImage(event) {
    if (event) event.stopPropagation();
    resetPanZoom();
    navigateWithFade('next');
}

function prevImage(event) {
    if (event) event.stopPropagation();
    resetPanZoom();
    navigateWithFade('prev');
}


// Update lightbox opening logic to align index with the full manifest
// Lightbox opener with fallback fetch

async function openLightboxByFilename(filename) {
    // 1. Ensure manifest is loaded
    if (!globalManifest || globalManifest.length === 0) {
        await initManifest();
    }

    const modal = document.getElementById('lightbox-modal');
    if (modal) modal.classList.remove('hidden');

    // 2. Find starting index
    const foundIndex = globalManifest.indexOf(filename);
    currentIndex = (foundIndex !== -1) ? foundIndex : 0;

    // 3. FORCE COUNTER REFRESH IMMEDIATELY
    updateCounterDisplay();

    // 4. Load image
    loadLightboxImage(currentIndex);
}
// Navigating cycles through ALL images in the manifest


// Variable to track if page fetching is in progress
let isLoadingNextPage = false;



async function navigateWithFade(direction) {
    if (!allImages || allImages.length === 0 || isTransitioning) return;

    let targetIndex = (direction === 'next') ? currentIndex + 1 : currentIndex - 1;

    // Fetch next chunk dynamically when lightbox hits the end of loaded array
    if (direction === 'next' && targetIndex >= allImages.length) {
        if (hasMore && !isLoadingNextPage) {
            isLoadingNextPage = true;
            const countFetched = await fetchNextPageOfImages();
            isLoadingNextPage = false;

            if (countFetched === 0) {
                targetIndex = 0; // Loop back to start if backend has no remaining items
            }
        } else if (!hasMore) {
            targetIndex = 0; // Loop back to beginning
        }
    } else if (direction === 'prev' && targetIndex < 0) {
        targetIndex = allImages.length - 1; // Wrap around to end
    }

    const activeContainer = isVideoFile(allImages[targetIndex]) 
        ? document.getElementById('modal-video') 
        : document.getElementById('modal-img');

    isTransitioning = true;
    if (activeContainer) activeContainer.classList.add('fade-out');

    setTimeout(() => {
        currentIndex = targetIndex;
        loadLightboxImage(currentIndex);
        updateCounterDisplay();

        if (activeContainer) activeContainer.classList.remove('fade-out');
        setTimeout(() => { isTransitioning = false; }, 150);
    }, 150);
}


let currentPage = 1;


// Keep track of the currently selected active album in JS state
let currentActiveAlbum = 'all'; // Default to 'all', updated whenever user selects an album tab

async function fetchNextPageOfImages() {
    const offset = allImages.length;
    const limit = 30;

    // 💡 Build query parameters including active album filter
    let url = `/api/images?offset=${offset}&limit=${limit}`;
    
    if (currentActiveAlbum && currentActiveAlbum !== 'all') {
        url += `&album=${encodeURIComponent(currentActiveAlbum)}`;
    }

    console.log(`📡 [PAGINATION] Requesting url: ${url}`);
    
    try {
        const response = await fetch(url);
        if (!response.ok) return 0;

        const data = await response.json(); // { images: [...], has_more: boolean }
        
        // If has_more is false and images array is empty, we reached the end of the album!
        const newBatch = (data.images || []).map(item => item.filename);

        if (newBatch.length === 0) {
            console.log(`🏁 Reached end of album "${currentActiveAlbum}". No more images.`);
            return 0;
        }

        allImages.push(...newBatch);

        if (typeof renderGridCards === 'function') {
            renderGridCards(data.images);
        }

        return newBatch.length;
    } catch (err) {
        console.error('❌ [PAGINATION] Album fetch failed:', err);
        return 0;
    }
}

// Lightbox loader targets filenames from globalManifest

function loadLightboxImage(index) {
    if (!allImages || allImages.length === 0) return; //

    const filename = allImages[index]; //
    if (!filename) return; //

    updateCounterDisplay(); //

    const imgElement = document.getElementById('modal-img'); //[cite: 2]
    const videoElement = document.getElementById('modal-video'); //[cite: 2]
    const spinner = document.getElementById('lightbox-spinner'); //[cite: 2]
    const downloadBtn = document.getElementById('lightbox-download-btn'); //[cite: 2]

    if (downloadBtn) {
        downloadBtn.innerHTML = SVG_ICONS.download; //[cite: 2]
        downloadBtn.disabled = false; //[cite: 2]
    }

    if (currentAbortController) {
        currentAbortController.abort(); //[cite: 2]
    }
    currentAbortController = new AbortController(); //[cite: 2]

    if (spinner) spinner.classList.remove('hidden'); //[cite: 2]

    const cleanStem = filename.includes('.') 
        ? filename.substring(0, filename.lastIndexOf('.')) 
        : filename; //[cite: 2]
        
    const thumbUrl = `/thumb/${cleanStem}.jpg`; //[cite: 2]
    const fullResUrl = `/images/${filename}`; //[cite: 2]

    // 🎬 VIDEO HANDLING
    if (isVideoFile(filename)) { //[cite: 2]
        if (imgElement) {
            imgElement.classList.add('hidden'); //[cite: 2]
            imgElement.src = ''; //[cite: 2]
        }

        if (videoElement) {
            videoElement.classList.remove('hidden'); //[cite: 2]
            videoElement.pause(); //[cite: 2]
            videoElement.src = fullResUrl; //[cite: 2]
            videoElement.load(); //[cite: 2]

            videoElement.onloadeddata = () => {
                if (currentIndex === index && spinner) spinner.classList.add('hidden'); //[cite: 2]
            };
            videoElement.onerror = () => {
                if (currentIndex === index && spinner) spinner.classList.add('hidden'); //[cite: 2]
            };
        }

        preloadAdjacentImages(index); //[cite: 2]
        return;
    }

    // 🖼️ IMAGE HANDLING
    if (videoElement) {
        videoElement.pause(); //[cite: 2]
        videoElement.classList.add('hidden'); //[cite: 2]
        videoElement.src = ''; //[cite: 2]
    }

    if (imgElement) {
        imgElement.classList.remove('hidden'); //[cite: 2]
        imgElement.src = ''; //[cite: 2]
        imgElement.classList.add('loading'); //[cite: 2]
        imgElement.src = thumbUrl; //[cite: 2]

        const highResImg = new Image(); //[cite: 2]
        highResImg.src = fullResUrl; //[cite: 2]

        const handleSuccess = () => {
            if (currentIndex === index) {
                imgElement.src = fullResUrl; //[cite: 2]
                imgElement.classList.remove('loading'); //[cite: 2]
                if (spinner) spinner.classList.add('hidden'); //[cite: 2]
            }
        };

        const handleError = () => {
            if (currentIndex === index) {
                imgElement.classList.remove('loading'); //[cite: 2]
                if (spinner) spinner.classList.add('hidden'); //[cite: 2]
            }
        };

        if ('decode' in highResImg) {
            highResImg.decode().then(handleSuccess).catch(handleError); //[cite: 2]
        } else {
            highResImg.onload = handleSuccess; //[cite: 2]
            highResImg.onerror = handleError; //[cite: 2]
        }
    }

    preloadAdjacentImages(index); //[cite: 2]
}








// Navigate Next / Prev
function navigateLightbox(direction) {
    if (!allImages || allImages.length === 0) return;

    let newIndex = currentIndex + direction;
    if (newIndex < 0) newIndex = allImages.length - 1;
    if (newIndex >= allImages.length) newIndex = 0;

    currentIndex = newIndex;

    // Load instantly
    loadLightboxImage(currentIndex);
}


// ⌨️ Keyboard Shortcuts (Arrow Left, Arrow Right, Escape)
function handleKeyPress(event) {
    if (event.key === 'ArrowRight') {
        nextImage();
    } else if (event.key === 'ArrowLeft') {
        prevImage();
    } else if (event.key === 'Escape') {
        closeModal();
    }
}


// 🎨 SVG Icon Templates for Button State Feedback
const SVG_ICONS = {
    download: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
    spinner: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite;"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>`,
    success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    error: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`
};

async function downloadCurrentLightboxImage() {
    const downloadBtn = document.getElementById('lightbox-download-btn');
    const filename = allImages[currentIndex];

    if (!filename) return;

    const fullResUrl = `/images/${filename}`;

    try {
        // Provide immediate visual feedback (SVG Spinner)
        if (downloadBtn) {
            downloadBtn.disabled = true;
            downloadBtn.innerHTML = SVG_ICONS.spinner;
        }

        // Fetch image as binary blob
        const response = await fetch(fullResUrl);
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        // Create temporary off-screen anchor tag
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();

        // Cleanup DOM and Blob memory
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

        // Reset button state to Checkmark SVG
        if (downloadBtn) {
            downloadBtn.innerHTML = SVG_ICONS.success;
            setTimeout(() => {
                downloadBtn.innerHTML = SVG_ICONS.download;
                downloadBtn.disabled = false;
            }, 1500);
        }

    } catch (err) {
        console.error('❌ Download failed:', err);
        if (downloadBtn) {
            downloadBtn.innerHTML = SVG_ICONS.error;
            setTimeout(() => {
                downloadBtn.innerHTML = SVG_ICONS.download;
                downloadBtn.disabled = false;
            }, 2000);
        }
    }
}

// 🎯 Fast Image Loading with Instant Thumbnail & Abort Control

// 2. Updated loadLightboxImage function
// Helper to detect video extensions
function isVideoFile(filename) {
    if (!filename) return false;
    const ext = filename.split('.').pop().toLowerCase();
    return ['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext);
}

// Update the function where gallery items are created


function loadLightboxImage(index) {
    const imgElement = document.getElementById('modal-img');
    const videoElement = document.getElementById('modal-video');
    const spinner = document.getElementById('lightbox-spinner');
    const downloadBtn = document.getElementById('lightbox-download-btn');
    const filename = allImages[index];

    if (!filename) return;

    // Reset download button icon if previously used
    if (downloadBtn) {
        downloadBtn.innerHTML = SVG_ICONS.download;
        downloadBtn.disabled = false;
    }

    // 1. Abort previous unfinished image decodes
    if (currentAbortController) {
        currentAbortController.abort();
    }
    currentAbortController = new AbortController();

    if (spinner) spinner.classList.remove('hidden');

    const cleanStem = filename.includes('.') 
        ? filename.substring(0, filename.lastIndexOf('.')) 
        : filename;
        
    const thumbUrl = `/thumb/${cleanStem}.jpg`;
    const fullResUrl = `/images/${filename}`;

    // 🎬 2. VIDEO HANDLING BRANCH
    if (isVideoFile(filename)) {
        // Hide image viewport and purge image RAM buffer
        if (imgElement) {
            imgElement.classList.add('hidden');
            imgElement.src = '';
        }

        if (videoElement) {
            videoElement.classList.remove('hidden');
            videoElement.pause();
            videoElement.src = fullResUrl;
            videoElement.load(); // Force video decoder buffer initialization

            videoElement.onloadeddata = () => {
                if (currentIndex === index && spinner) {
                    spinner.classList.add('hidden');
                }
            };

            videoElement.onerror = () => {
                if (currentIndex === index && spinner) {
                    spinner.classList.add('hidden');
                }
            };
        }

        // Preload adjacent items (videos or images)
        preloadAdjacentImages(index);
        return;
    }

    // 🖼️ 3. IMAGE HANDLING BRANCH (Existing RAM-efficient workflow)
    if (videoElement) {
        videoElement.pause();
        videoElement.classList.add('hidden');
        videoElement.src = ''; // Clear video buffer from mobile RAM
    }

    if (imgElement) {
        imgElement.classList.remove('hidden');

        // Clear RAM buffer & set immediate low-res thumbnail preview
        imgElement.src = '';
        imgElement.classList.add('loading');
        imgElement.src = thumbUrl; 

        // Decode full-res image in background
        const highResImg = new Image();
        highResImg.src = fullResUrl;

        const handleSuccess = () => {
            if (currentIndex === index) {
                imgElement.src = fullResUrl;
                imgElement.classList.remove('loading');
                if (spinner) spinner.classList.add('hidden');
            }
        };

        const handleError = () => {
            if (currentIndex === index) {
                imgElement.classList.remove('loading');
                if (spinner) spinner.classList.add('hidden');
            }
        };

        if ('decode' in highResImg) {
            highResImg.decode().then(handleSuccess).catch(handleError);
        } else {
            highResImg.onload = handleSuccess;
            highResImg.onerror = handleError;
        }
    }

    preloadAdjacentImages(index);
}



// Optional JS helper if mobile browsers ignore the `download` attribute
function forceDownloadImage(url, filename) {
    fetch(url)
        .then(res => res.blob())
        .then(blob => {
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        })
        .catch(err => console.error("Download failed:", err));
}

// 🔮 Preload next and previous high-res images
function preloadAdjacentImages(index) {
    const nextIdx = (index + 1) % allImages.length;
    const prevIdx = (index - 1 + allImages.length) % allImages.length;

    [nextIdx, prevIdx].forEach(idx => {
        const file = allImages[idx];
        if (file) {
            const preloadImg = new Image();
            preloadImg.src = `/images/${file}`;
        }
    });
}





// --- Window Scroll Pagination ---
window.onscroll = () => {
    if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 800) {
        loadImages();
    }
};

// Function to control visibility of the Load More button
function updateLoadMoreButtonVisibility(hasMoreItems) {
    const container = document.getElementById('load-more-container');
    if (!container) return;

    if (hasMoreItems) {
        container.style.display = 'block'; // Show button if more images exist
    } else {
        container.style.display = 'none';  // Hide button if all images are loaded
    }
}



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

async function bootAppWithVanityRouting() {
    await loadAlbumDropdownOptions();

    const pathParts = window.location.pathname.split('/');
    const urlAlbum = pathParts[1] && pathParts[1] !== "" ? decodeURIComponent(pathParts[1]) : "all";

    if (urlAlbum !== "all" && urlAlbum !== "static" && urlAlbum !== "api" && urlAlbum !== "images" && urlAlbum !== "thumb") {
        const albumSelect = document.getElementById('album-select');
        if (albumSelect) {
            const targetLower = urlAlbum.toLowerCase();
            let matchedOptionValue = null;

            for (let i = 0; i < albumSelect.options.length; i++) {
                if (albumSelect.options[i].value.toLowerCase() === targetLower) {
                    matchedOptionValue = albumSelect.options[i].value;
                    break;
                }
            }

            if (matchedOptionValue !== null) {
                albumSelect.value = matchedOptionValue;
            } else {
                const opt = document.createElement('option');
                opt.value = urlAlbum;
                opt.innerText = `📂 ${urlAlbum}`;
                albumSelect.appendChild(opt);
                albumSelect.value = urlAlbum;
            }
        }
    }

    await loadImages();
    setupWebSocket();
}

// Execute synchronized startup sequence
bootAppWithVanityRouting();


// Scale state tracking
let currentScale = 1;
let lastTapTime = 0;
const doubleTapDelay = 300;

function initTouchEvents() {
    const imgElement = document.getElementById('modal-img');
    if (!imgElement) return;

    // Optional: Keep ONLY Double-Tap Zoom on the image
    imgElement.addEventListener('touchend', handleImageDoubleTap);
}

function handleImageDoubleTap(e) {
    const currentTime = new Date().getTime();
    const tapLength = currentTime - lastTapTime;

    if (tapLength < doubleTapDelay && tapLength > 0) {
        e.preventDefault();
        const imgElement = document.getElementById('modal-img');
        if (!imgElement) return;

        if (currentScale > 1.05) {
            resetPanZoom();
        } else {
            const touch = e.changedTouches[0];
            const rect = imgElement.getBoundingClientRect();
            const offsetX = (touch.clientX - rect.left) / rect.width;
            const offsetY = (touch.clientY - rect.top) / rect.height;

            currentScale = 2.5;
            imgElement.style.transition = 'transform 0.25s ease-out';
            imgElement.style.transformOrigin = `${offsetX * 100}% ${offsetY * 100}%`;
            imgElement.style.transform = `scale(${currentScale})`;
        }
        lastTapTime = 0;
        return;
    }
    lastTapTime = currentTime;
}

function resetPanZoom() {
    const imgElement = document.getElementById('modal-img');
    if (!imgElement) return;

    currentScale = 1;
    imgElement.style.transition = 'none';
    imgElement.style.transform = 'none';
    imgElement.style.transformOrigin = 'center center';
}




document.addEventListener('DOMContentLoaded', initTouchEvents);

async function triggerDirectoryScan() {
    const scanBtn = document.getElementById('scan-btn');
    const scanIcon = document.getElementById('scan-icon');
    const scanText = document.getElementById('scan-text');

    if (scanBtn) {
        scanBtn.disabled = true;
        scanBtn.classList.add('btn-scanning');
    }
    
    if (scanIcon) {
        scanIcon.classList.add('scan-spinning');
    }

    if (scanText) {
        scanText.innerText = 'Scanning...';
    }

    try {
        const response = await fetch('/api/scan', { method: 'POST' });
        const result = await response.json();

        if (result.success) {
            // Optional: Give quick feedback before refreshing
            if (result.added > 0) {
                console.log(`Scan finished: Cataloged ${result.added} new files.`);
            }
            
            // Re-fetch images array to populate UI grid automatically
            if (typeof fetchImages === 'function') {
                await fetchImages();
            }
        } else {
            alert('Scan failed: ' + result.error);
        }
    } catch (err) {
        console.error('Scan request failed:', err);
        alert('Failed to connect to server for scan.');
    } finally {
        // Reset button state and stop animation
        if (scanBtn) {
            scanBtn.disabled = false;
            scanBtn.classList.remove('btn-scanning');
        }
        if (scanIcon) {
            scanIcon.classList.remove('scan-spinning');
        }
        if (scanText) {
            scanText.innerText = 'Scan';
        }
    }
}


async function getOrVerifyMasterPassword() {
    let password = sessionStorage.getItem('gallery_session_pwd');

    // 1. Check if stored password is still valid with the server
    if (password) {
        const isValid = await checkPasswordWithServer(password);
        if (isValid) return password;
        
        // Purge if invalid
        sessionStorage.removeItem('gallery_session_pwd');
    }

    // 2. Open custom HTML modal if no valid session password exists
    return openAuthModal();
}

function openAuthModal() {
    const modal = document.getElementById('auth-modal');
    const input = document.getElementById('auth-password-field');
    
    if (modal) {
        if (input) input.value = '';
        modal.style.display = 'flex'; // or 'block' based on your CSS
        if (input) input.focus();
    }

    // Return a Promise that resolves when user clicks Confirm or Cancel
    return new Promise((resolve) => {
        authModalResolver = resolve;
    });
}

async function checkPasswordWithServer(pwd) {
    try {
        const res = await fetch('/api/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd })
        });
        return res.status === 200;
    } catch (err) {
        console.error("Auth verification failed:", err);
        return false;
    }
}
