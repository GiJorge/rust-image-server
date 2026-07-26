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
        // When allImages has 60 items, index 30 becomes: "31 / 60"
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

    const cleanBase = name.includes('.') ? name.substring(0, name.lastIndexOf('.')) : name;
    const thumbFilename = cleanBase + '.jpg';
    const albumName = imageAlbumMap[name] || "";

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

// --- Data Fetching and Multi-Upload Handler ---

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
        loadingIndicator.style.display = 'none';
    }
}



let totalBatchCount = 0;
let processedBatchCount = 0;

function handleUpload(input) {
    if (!input.files || input.files.length === 0) return;
    const password = sessionStorage.getItem('gallery_session_pwd');
    const files = Array.from(input.files);

    const formData = new FormData();
    formData.append('password', password || '');
    formData.append('album', globalSelectedUploadAlbum || '');

    files.forEach(file => {
        formData.append('image', file);
        pendingUploads.add(file.name);
    });

    // Setup global counters for real-time WebSocket tracking
    totalBatchCount = files.length;
    processedBatchCount = 0;

    // --- UI Progress Bar References ---
    const progressContainer = document.getElementById('upload-progress-container');
    const progressText = document.getElementById('upload-progress-text');
    const progressPercent = document.getElementById('upload-progress-percent');
    const progressBarFill = document.getElementById('upload-progress-bar-fill');

    // Display progress bar
    progressText.innerText = `Uploading ${files.length} file(s)...`;
    progressPercent.innerText = '0%';
    progressBarFill.style.width = '0%';
    progressContainer.style.display = 'block';
    progressContainer.style.opacity = '1';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);

    // Track initial Network Transfer Progress (0% to 50%)
    xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && totalBatchCount > 0) {
            const uploadPercent = Math.round((event.loaded / event.total) * 50); // Scale up to 50%
            progressBarFill.style.width = uploadPercent + '%';
            progressPercent.innerText = uploadPercent + '%';
            
            if (uploadPercent >= 50) {
                progressText.innerText = `Processing thumbnails (0/${totalBatchCount})...`;
            }
        }
    };

    xhr.onload = () => {
        if (xhr.status === 200) {
            files.forEach(file => pendingUploads.delete(file.name));
            // Don't hide the progress bar yet! Let setupWebSocket complete the tracking.
        } else if (xhr.status === 401) {
            alert("Upload unauthorized. Resetting session credentials.");
            sessionStorage.removeItem('gallery_session_pwd');
            progressContainer.style.display = 'none';
        } else {
            alert("Upload failed: " + xhr.responseText);
            progressContainer.style.display = 'none';
        }
    };

    xhr.onerror = () => {
        alert("Network transmission error occurred.");
        progressContainer.style.display = 'none';
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
    const offset = allImages.length;
    const limit = 30;

    // Build URL with offset, limit, and active album filter
    let url = `/api/images?offset=${offset}&limit=${limit}`;
    
    // Append album parameter if not default 'all'
    if (currentActiveAlbum !== 'all') {
        url += `&album=${encodeURIComponent(currentActiveAlbum)}`;
    }

    console.log(`📡 [PAGINATION] Requesting: ${url}`);
    
    try {
        const response = await fetch(url);
        if (!response.ok) return 0;

        const data = await response.json(); // Returns { images: [...], has_more: boolean }
        const newBatch = (data.images || []).map(item => item.filename);

        if (newBatch.length === 0) {
            console.log(`🏁 No more images found for album: "${currentActiveAlbum}".`);
            return 0;
        }

        // Append only filtered album images to master list
        allImages.push(...newBatch);

        if (typeof renderGridCards === 'function') {
            renderGridCards(data.images);
        }

        return newBatch.length;
    } catch (err) {
        console.error('❌ [PAGINATION] Fetch failed:', err);
        return 0;
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
function closeModal() {
    const modal = document.getElementById('modal-container');
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
    if (isTransitioning) return;
    navigateWithFade('next');
}

function prevImage(event) {
    if (event) event.stopPropagation();
    if (isTransitioning) return;
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
    if (!allImages || allImages.length === 0) return;

    const imgElement = document.getElementById('modal-img');
    if (!imgElement) return;

    isTransitioning = true;
    resetPanZoom();

    let targetIndex = currentIndex;

    if (direction === 'next') {
        targetIndex = currentIndex + 1;
    } else {
        targetIndex = currentIndex - 1;
    }

    // 🚀 REACHED END OF CURRENTLY LOADED ARRAY (e.g. index 30 of 30)
   if (direction === 'next' && targetIndex >= allImages.length) {
    console.log(`🚨 [NAVIGATION] Reached end of loaded array (${allImages.length} items). Fetching more...`);

    if (!isLoadingNextPage) {
        isLoadingNextPage = true;
        const countFetched = await fetchNextPageOfImages();
        isLoadingNextPage = false;

        console.log(`🏁 [NAVIGATION] Fetch completed. New countFetched = ${countFetched}, total allImages = ${allImages.length}`);

        if (countFetched === 0) {
            console.warn(`⚠️ [NAVIGATION] Backend has no more images. Looping to 0.`);
            targetIndex = 0;
        } else {
            // Target index 30 is now valid because allImages length is > 30!
            console.log(`🎉 [NAVIGATION] Successfully extended array. Moving to index ${targetIndex}`);
        }
    } else {
        console.log(`⏳ [NAVIGATION] Fetch already in progress, skipping duplicate call.`);
    }
}

    // Fade OUT and swap to target index
    imgElement.classList.add('fade-out');

    setTimeout(() => {
        currentIndex = targetIndex;

        // Update counter (will now correctly show 31 / 60)
        updateCounterDisplay();

        // Load image 31
        loadLightboxImage(currentIndex);

        imgElement.classList.remove('fade-out');

        setTimeout(() => {
            isTransitioning = false;
        }, 150);

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
    if (!allImages || allImages.length === 0) return;

    const filename = allImages[index];
    if (!filename) return;

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

    // Reset RAM for low-end mobile hardware
    imgElement.src = '';

    // Test if thumbnail exists before assigning
    const thumbTester = new Image();
    thumbTester.src = thumbUrl;
    
    thumbTester.onload = () => {
        if (currentIndex === index) {
            imgElement.src = thumbUrl; // Show low-res preview first
        }
    };
    
    thumbTester.onerror = () => {
        // Thumbnail 404s -> Skip straight to full resolution image
        console.warn(`[THUMBNAIL 404] Missing thumbnail for ${filename}, loading full resolution directly.`);
    };

    // Load full-resolution image
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
            console.error(`❌ Failed to load image: ${fullResUrl}`);
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

// 🎯 Fast Image Loading with Instant Thumbnail & Abort Control
function loadLightboxImage(index) {
    const imgElement = document.getElementById('modal-img');
    const spinner = document.getElementById('lightbox-spinner');
    const filename = allImages[index];

    if (!filename) return;

    // 1. Abort previous unfinished requests
    if (currentAbortController) {
        currentAbortController.abort();
    }
    currentAbortController = new AbortController();

    // 2. SHOW SPINNER
    if (spinner) spinner.classList.remove('hidden');

    const cleanStem = filename.includes('.') 
        ? filename.substring(0, filename.lastIndexOf('.')) 
        : filename;
        
    const thumbUrl = `/thumb/${cleanStem}.jpg`;
    const fullResUrl = `/images/${filename}`;

    // 3. 🧹 MEMORY GARBAGE COLLECTION FOR BUDGET PHONES:
    // Force browser to dump the previous high-res image bitmap from RAM
    imgElement.src = '';

    // Show thumbnail instantly first
    imgElement.classList.add('loading');
    imgElement.src = thumbUrl; 

    // 4. Decode full-resolution image in background
    const highResImg = new Image();
    highResImg.src = fullResUrl;

    const handleSuccess = () => {
        if (currentIndex === index) {
            imgElement.src = fullResUrl;
            imgElement.classList.remove('loading');
            // HIDE SPINNER
            if (spinner) spinner.classList.add('hidden');
        }
    };

    const handleError = () => {
        if (currentIndex === index) {
            imgElement.classList.remove('loading');
            // HIDE SPINNER
            if (spinner) spinner.classList.add('hidden');
        }
    };

    if ('decode' in highResImg) {
        highResImg.decode().then(handleSuccess).catch(handleError);
    } else {
        highResImg.onload = handleSuccess;
        highResImg.onerror = handleError;
    }

    // 5. Preload adjacent images
    preloadAdjacentImages(index);
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


// ==========================================
// 📱 TOUCH & SWIPE NAVIGATION LOGIC
// ==========================================

let touchStartX = 0;
let touchStartY = 0;
let touchEndX = 0;
let touchEndY = 0;

// Minimum horizontal distance (in pixels) to trigger a swipe
const minSwipeDistance = 50; 
// Maximum vertical threshold to prevent triggering swipe when scrolling vertically
const maxVerticalTolerance = 80; 


function initTouchEvents() {
    const modal = document.getElementById('modal-container');
    if (!modal) return;

    modal.addEventListener('touchstart', handleTouchStart, { passive: true });
    // Set passive: false so e.preventDefault() works cleanly on touchmove
    modal.addEventListener('touchmove', handleTouchMove, { passive: false });
    modal.addEventListener('touchend', handleTouchEnd, { passive: true });
}


function handleTouchStart(e) {
    // Record initial touch coordinates
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
}


function handleTouchMove(e) {
    // Prevent the default browser behavior (prevents background scroll & pull-to-refresh)
    if (e.cancelable) {
        e.preventDefault();
    }

    touchEndX = e.changedTouches[0].screenX;
    touchEndY = e.changedTouches[0].screenY;
}

function handleTouchEnd(e) {
    touchEndX = e.changedTouches[0].screenX;
    touchEndY = e.changedTouches[0].screenY;

    handleSwipeGesture();
}

function handleSwipeGesture() {
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;

    if (Math.abs(deltaY) > maxVerticalTolerance) return;

    if (Math.abs(deltaX) >= minSwipeDistance) {
        if (deltaX < 0) {
            // Swiped Left 👈 -> Slide to Next
            nextImage();
        } else {
            // Swiped Right 👉 -> Slide to Previous
            prevImage();
        }
    }
}

// Ensure listeners are initialized when DOM is ready
document.addEventListener('DOMContentLoaded', initTouchEvents);

function resetPanZoom() {
    const imgElement = document.getElementById('modal-img');
    if (!imgElement) return;

    // Reset inline CSS transforms
    imgElement.style.transform = 'none';
    imgElement.style.transformOrigin = 'center center';

    // Reset custom tracking variables if you are keeping state manually
    if (typeof currentScale !== 'undefined') currentScale = 1;
    if (typeof currentPanX !== 'undefined') currentPanX = 0;
    if (typeof currentPanY !== 'undefined') currentPanY = 0;
}