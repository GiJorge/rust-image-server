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

// Custom Password Modal Controllers
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

function triggerUploadCheck() {
    requestActionAuthorization(() => {
        document.getElementById('file-input').click();
    });
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

async function handleUpload(input) {
    if (!input.files || input.files.length === 0) return;
    const password = sessionStorage.getItem('gallery_session_pwd');

    const file = input.files[0];
    const formData = new FormData();
    formData.append('image', file);
    formData.append('password', password);

    const overlay = document.getElementById('loading-overlay');
    const status = document.getElementById('upload-status');
    overlay.style.display = 'flex';
    status.innerText = `Uploading ${file.name}...`;

    try {
        pendingUploads.add(file.name);
        const response = await fetch('/api/upload', { method: 'POST', body: formData });

        if (response.ok) {
            const data = await response.json();
            status.innerText = 'Success!';
            pendingUploads.delete(file.name);

            const activeSearch = document.getElementById('search-input').value.toLowerCase().trim();
            const activeSort = document.getElementById('sort-select').value;
            const sizeFilterSetting = document.getElementById('size-select').value;
            const fileSizeInBytes = file.size;

            const isFiltering = (activeSearch !== "") || (sizeFilterSetting !== "all") || (activeSort !== "recent");
            let matchesSearch = activeSearch === "" || data.filename.toLowerCase().includes(activeSearch);
            let matchesSize = true;

            if (sizeFilterSetting === 'small') matchesSize = fileSizeInBytes < 1048576;
            else if (sizeFilterSetting === 'medium') matchesSize = fileSizeInBytes >= 1048576 && fileSizeInBytes <= 5242880;
            else if (sizeFilterSetting === 'large') matchesSize = fileSizeInBytes > 5242880;

            if (!isFiltering || (activeSort === 'recent' && matchesSearch && matchesSize)) {
                allImages.unshift(data.filename);
                offset += 1;
                renderGalleryHTML();
            } else {
                setTimeout(() => { alert(`Uploaded successfully! Clear active filters to see "${file.name}".`); }, 700);
            }
            setTimeout(() => { overlay.style.display = 'none'; }, 600);
        } else if (response.status === 401) {
            alert("Unauthorized: Incorrect password.");
            sessionStorage.removeItem('gallery_session_pwd');
            overlay.style.display = 'none';
        } else {
            const errorText = await response.text();
            alert("Upload failed: " + errorText);
            overlay.style.display = 'none';
        }
    } catch (err) {
        console.error(err);
        overlay.style.display = 'none';
    }
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

async function loadImages() {
    if (loading || !hasMore) return;
    loading = true;
    loadingIndicator.style.display = 'block';

    const search = document.getElementById('search-input').value;
    const sort = document.getElementById('sort-select').value;
    const sizeValue = document.getElementById('size-select').value;

    let sizeParams = '';
    if (sizeValue === 'small') sizeParams = '&max_size=1048576';
    else if (sizeValue === 'medium') sizeParams = '&min_size=1048576&max_size=5242880';
    else if (sizeValue === 'large') sizeParams = '&min_size=5242880';

    try {
        const url = `/api/images?offset=${offset}&limit=${limit}&search=${encodeURIComponent(search)}&sort=${sort}${sizeParams}`;
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
setupWebSocket();
loadImages();