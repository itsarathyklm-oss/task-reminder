let currentAuthMode = 'login';
let allTasks = [];
let allProjects = [];
let currentTaskFilter = 'pending';
let taskCurrentPage = 1;
const taskPageSize = 5;

// Toast notification system
function showToast(title, message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    let icon, bgColor;
    if (type === 'success') {
        icon = '✅';
        bgColor = 'bg-emerald-50 border-emerald-200';
    } else if (type === 'error') {
        icon = '❌';
        bgColor = 'bg-red-50 border-red-200';
    } else if (type === 'warning') {
        icon = '⚠️';
        bgColor = 'bg-orange-50 border-orange-200';
    } else {
        icon = 'ℹ️';
        bgColor = 'bg-blue-50 border-blue-200';
    }

    const toast = document.createElement('div');
    toast.className = `pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border ${bgColor} transform transition-all duration-300 translate-x-[120%] opacity-0 max-w-xs ml-auto`;
    toast.innerHTML = `
        <span class="text-lg shrink-0">${icon}</span>
        <div class="min-w-0">
            <p class="text-xs font-bold text-slate-800 truncate">${title}</p>
            <p class="text-[10px] text-slate-500 truncate">${message}</p>
        </div>
    `;

    container.appendChild(toast);

    // Slide in (double rAF ensures the initial state is painted first)
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.classList.remove('translate-x-[120%]', 'opacity-0');
            toast.classList.add('translate-x-0', 'opacity-100');
        });
    });

    // Auto-dismiss after 3 seconds
    setTimeout(() => {
        toast.classList.add('translate-x-[120%]', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function closeToast() {
    // No-op — toasts auto-dismiss now
}

// 1. Authenticated API Helper (automatically appends JWT token)
async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('token');
    
    options.headers = options.headers || {};
    if (token) {
        options.headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, options);

    if (res.status === 401 || res.status === 403) {
        logout();
        throw new Error('Session expired. Please log in again.');
    }

    return res;
}

// Authenticated file URL helper — adds token for local uploads (Cloudinary URLs unchanged)
function authFileUrl(filePath) {
    if (!filePath) return null;
    if (filePath.startsWith('http')) return filePath;
    const token = localStorage.getItem('token') || '';
    return '/uploads/' + filePath + '?token=' + encodeURIComponent(token);
}

// Safe date parser: handles '2026-09-16 12:00:00' (MySQL) as LOCAL time
// Also handles ISO strings with timezone info (e.g. '2026-09-16T11:30:00.000Z')
function parseDate(str) {
    if (!str) return new Date(NaN);
    // If it's a Date object, use it directly
    if (str instanceof Date) return str;
    // ISO format with timezone info — let the browser parse it natively
    // so UTC (Z) or offset (+/-) is handled correctly
    if (typeof str === 'string' && str.includes('T') && /[Zz]|[+-]\d{2}:?\d{2}$/.test(str)) {
        return new Date(str);
    }
    // MySQL DATETIME format ('2026-09-16 17:00:00') — treat as local time
    const clean = str.replace('T', ' ').trim();
    const parts = clean.split(/[\s:T-]/).filter(Boolean);
    if (parts.length < 3) return new Date(NaN);
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const dd = parseInt(parts[2], 10);
    const h = parts.length > 3 ? parseInt(parts[3], 10) : 0;
    const min = parts.length > 4 ? parseInt(parts[4], 10) : 0;
    const sec = parts.length > 5 ? parseInt(parts[5], 10) : 0;
    return new Date(y, m, dd, h, min, sec);
}

// Format date for display (DD/MM/YYYY)
function formatDate(str) {
    const d = parseDate(str);
    if (isNaN(d.getTime())) return str || '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return dd + '/' + mm + '/' + yyyy;
}

// Format date + time for display (DD/MM/YYYY HH:MM AM/PM)
function formatDateTime(str) {
    const d = parseDate(str);
    if (isNaN(d.getTime())) return str || '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    return dd + '/' + mm + '/' + yyyy + ' ' + time;
}

// AM/PM Time Picker Helpers
function ampTo24(hour, min, ampm) {
    let h = parseInt(hour, 10);
    if (ampm === 'AM' && h === 12) h = 0;
    else if (ampm === 'PM' && h < 12) h += 12;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

function time24ToAmpm(time24) {
    const [h, m] = (time24 || '09:00').split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    let h12 = h % 12 || 12;
    return { hour: h12, min: m, ampm };
}

function populateTimeSelects(hourId, minId, ampmId, defaultTime) {
    const hourEl = document.getElementById(hourId);
    const minEl = document.getElementById(minId);
    const ampmEl = document.getElementById(ampmId);
    if (!hourEl) return;
    hourEl.innerHTML = '';
    minEl.innerHTML = '';
    for (let i = 1; i <= 12; i++) hourEl.innerHTML += '<option value="' + i + '">' + String(i).padStart(2, '0') + '</option>';
    for (let i = 0; i < 60; i += 5) minEl.innerHTML += '<option value="' + i + '">' + String(i).padStart(2, '0') + '</option>';
    const t = time24ToAmpm(defaultTime || '09:00');
    hourEl.value = t.hour;
    minEl.value = t.min;
    ampmEl.value = t.ampm;
}

// 2. Auth State & Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    populateTimeSelects('taskTimeHour', 'taskTimeMin', 'taskTimeAmpm', '09:00');
    populateTimeSelects('reminderTimeHour', 'reminderTimeMin', 'reminderTimeAmpm', '09:00');
    checkAuth();

    // Login / Registration Form Handler
    document.getElementById('authForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('authError');
        errorEl.classList.add('hidden');

        const email = document.getElementById('authEmail').value;
        const password = document.getElementById('authPassword').value;
        const name = document.getElementById('authName').value;

        const endpoint = currentAuthMode === 'login' ? '/api/auth/login' : '/api/auth/register';
        const payload = currentAuthMode === 'login' ? { email, password } : { name, email, password };

        const btnText = document.getElementById('authBtnText');
        const spinner = document.getElementById('authSpinner');
        const btn = document.getElementById('authSubmitBtn');
        btn.disabled = true;
        btnText.classList.add('hidden');
        spinner.classList.remove('hidden');

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (!res.ok) {
                errorEl.innerText = data.error || 'Authentication failed.';
                errorEl.classList.remove('hidden');
                btn.disabled = false;
                btnText.classList.remove('hidden');
                spinner.classList.add('hidden');
                return;
            }

            if (currentAuthMode === 'register') {
                showToast('Account Created', 'Your account has been created successfully! Please log in.', 'success');
                switchAuthTab('login');
                btn.disabled = false;
                btnText.classList.remove('hidden');
                spinner.classList.add('hidden');
            } else {
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                showToast('Welcome Back', 'You have logged in successfully!', 'success');
                // Request browser notification permission
                if ('Notification' in window && Notification.permission === 'default') {
                    Notification.requestPermission();
                }
                setTimeout(function() { checkAuth(); }, 800);
            }
        } catch (err) {
            errorEl.innerText = 'Network error. Try again.';
            errorEl.classList.remove('hidden');
            btn.disabled = false;
            btnText.classList.remove('hidden');
            spinner.classList.add('hidden');
        }
    });

    // Submit New Task
    document.getElementById('taskForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const payload = {
            title: document.getElementById('taskTitle').value,
            description: document.getElementById('taskDesc').value,
            due_date: document.getElementById('taskDate').value,
            due_time: ampTo24(document.getElementById('taskTimeHour').value, document.getElementById('taskTimeMin').value, document.getElementById('taskTimeAmpm').value)
        };

        const res = await apiFetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            document.getElementById('taskForm').reset();
            populateTimeSelects('taskTimeHour', 'taskTimeMin', 'taskTimeAmpm', '09:00');
            showToast('Task Created', 'Your task has been added successfully!', 'success');
            refreshDashboard();
        } else {
            const data = await res.json();
            showToast('Error', data.error || 'Failed to add task.', 'error');
        }
    });

    // Submit Software & Document
    document.getElementById('softwareForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.innerText = 'Saving...';
        
        const formData = new FormData(document.getElementById('softwareForm'));

        try {
            const res = await apiFetch('/api/projects', {
                method: 'POST',
                body: formData 
            });

            const data = await res.json();

            if (res.ok) {
                document.getElementById('softwareForm').reset();
                refreshDashboard();
                showToast('Subscription Saved', 'Your subscription has been added successfully.', 'success');
            } else {
                showToast('Save Failed', data.error || 'Failed to save subscription.', 'error');
            }
        } catch (err) {
            showToast('Network Error', err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerText = 'Save Subscription';
        }
    });

    // Edit Subscription Form
    document.getElementById('editSubscriptionForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.innerText = 'Saving...';

        const id = document.getElementById('editSubId').value;
        const data = {
            software_name: document.getElementById('editSubName').value,
            launch_date: document.getElementById('editSubLaunch').value || null,
            next_renewal_date: document.getElementById('editSubRenewal').value,
            renewal_cycle: document.getElementById('editSubCycle').value,
            doc_type: document.getElementById('editSubDocType').value || null
        };

        try {
            const res = await apiFetch(`/api/projects/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            if (res.ok) {
                showToast('Subscription Updated', result.message, 'success');
                closeEditSubscriptionModal();
                fetchProjects();
            } else {
                const errEl = document.getElementById('editSubError');
                errEl.textContent = result.error || 'Update failed';
                errEl.classList.remove('hidden');
            }
        } catch (err) {
            const errEl = document.getElementById('editSubError');
            errEl.textContent = 'Network error. Please try again.';
            errEl.classList.remove('hidden');
        } finally {
            btn.disabled = false;
            btn.innerText = 'Save Changes';
        }
    });

    // Submit Renewal Payment
    document.getElementById('renewForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.innerText = 'Saving...';

        const id = document.getElementById('renewProjectId').value;
        const formData = new FormData();
        formData.append('next_renewal_date', document.getElementById('renewNextDate').value);
        formData.append('amount_paid', document.getElementById('renewAmount').value || 0);
        formData.append('payment_method', document.getElementById('renewMethod').value);
        formData.append('notes', document.getElementById('renewNotes').value);
        const docFile = document.getElementById('renewDoc').files[0];
        if (docFile) formData.append('document', docFile);

        try {
            const res = await apiFetch(`/api/projects/${id}/renew`, {
                method: 'PUT',
                body: formData
            });

            const data = await res.json();

            if (res.ok) {
                closeRenewModal();
                showToast('Payment Recorded', `Renewal updated to ${data.next_renewal_date}.`, 'success');
                refreshDashboard();
            } else {
                showToast('Renewal Failed', data.error || 'Could not update renewal status.', 'error');
            }
        } catch (err) {
            showToast('Network Error', err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerText = 'Confirm Payment';
        }
    });
});

// 3. Auth UI Controls
let notificationInterval = null;
let liveNotifications = [];
let prevNotifCount = 0;

// Persistent dismissed notifications tracking
function getDismissedNotifications() {
    try {
        return JSON.parse(localStorage.getItem('dismissedNotifications') || '[]');
    } catch (e) { return []; }
}
function saveDismissedNotifications(list) {
    // Clean up entries older than 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const filtered = list.filter(d => d.ts > cutoff);
    localStorage.setItem('dismissedNotifications', JSON.stringify(filtered));
}
function getNotificationId(n) {
    return n.type + '|' + n.title + '|' + (n.date || '');
}
function isDismissed(n) {
    const id = getNotificationId(n);
    return getDismissedNotifications().some(d => d.id === id);
}
function dismissNotification(n) {
    const id = getNotificationId(n);
    const dismissed = getDismissedNotifications();
    if (!dismissed.some(d => d.id === id)) {
        dismissed.push({ id: id, ts: Date.now() });
        saveDismissedNotifications(dismissed);
    }
    liveNotifications = liveNotifications.filter(ln => getNotificationId(ln) !== id);
    updateBellBadge(liveNotifications.length);
    renderNotifDropdown();
}

// Close search dropdown when clicking outside
document.addEventListener('click', (e) => {
    const searchWrapper = document.getElementById('globalSearchInput')?.parentElement;
    if (searchWrapper && !searchWrapper.contains(e.target)) {
        document.getElementById('searchResultsDropdown').classList.add('hidden');
    }
});

function globalSearch() {
    const keyword = document.getElementById('globalSearchInput').value.toLowerCase().trim();
    const dd = document.getElementById('searchResultsDropdown');

    if (!keyword) {
        dd.classList.add('hidden');
        return;
    }

    let results = [];

    // Search tasks
    if (allTasks && Array.isArray(allTasks)) {
        allTasks.forEach(task => {
            const matchTitle = task.title.toLowerCase().includes(keyword);
            const matchDesc = task.description && task.description.toLowerCase().includes(keyword);
            if (matchTitle || matchDesc) {
                const isCompleted = task.status === 'completed';
                const date = formatDate(task.due_date);
                results.push({
                    type: 'task',
                    title: task.title,
                    subtitle: `${isCompleted ? '✅ Done' : '⏳ Pending'} · ${date}`,
                    icon: isCompleted ? '✅' : '📋',
                    action: () => { filterByStatCard(isCompleted ? 'completed' : 'pending'); }
                });
            }
        });
    }

    // Search subscriptions
    if (allProjects && Array.isArray(allProjects)) {
        allProjects.forEach(proj => {
            const matchName = proj.software_name.toLowerCase().includes(keyword);
            const matchCycle = proj.renewal_cycle && proj.renewal_cycle.toLowerCase().includes(keyword);
            if (matchName || matchCycle) {
                const date = formatDate(proj.next_renewal_date);
                results.push({
                    type: 'subscription',
                    title: proj.software_name,
                    subtitle: `${proj.renewal_cycle} · Renews: ${date}`,
                    icon: '💻',
                    action: () => { filterView('renewals'); }
                });
            }
        });
    }

    if (results.length === 0) {
        dd.innerHTML = '<div class="p-4 text-center text-slate-400 text-xs">No results found</div>';
        dd.classList.remove('hidden');
        return;
    }

    // Group results by type
    const taskResults = results.filter(r => r.type === 'task');
    const subResults = results.filter(r => r.type === 'subscription');
    _lastSearchTasks = taskResults;
    _lastSearchSubs = subResults;

    let html = '';

    if (taskResults.length > 0) {
        html += '<div class="px-3 pt-3 pb-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Tasks</div>';
        taskResults.forEach((r, i) => {
            html += `
                <div onclick="searchNav('task',${i})" class="px-3 py-2.5 hover:bg-slate-50 cursor-pointer flex items-center gap-2.5 transition-all border-b border-slate-50">
                    <span class="text-sm shrink-0">${r.icon}</span>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-slate-800 truncate">${r.title}</p>
                        <p class="text-[10px] text-slate-400">${r.subtitle}</p>
                    </div>
                </div>
            `;
        });
    }

    if (subResults.length > 0) {
        html += '<div class="px-3 pt-3 pb-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Subscriptions</div>';
        subResults.forEach((r, i) => {
            html += `
                <div onclick="searchNav('sub',${i})" class="px-3 py-2.5 hover:bg-slate-50 cursor-pointer flex items-center gap-2.5 transition-all border-b border-slate-50">
                    <span class="text-sm shrink-0">${r.icon}</span>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-slate-800 truncate">${r.title}</p>
                        <p class="text-[10px] text-slate-400">${r.subtitle}</p>
                    </div>
                </div>
            `;
        });
    }

    dd.innerHTML = html;
    dd.classList.remove('hidden');
}

// Store last search results for navigation
let _lastSearchTasks = [];
let _lastSearchSubs = [];

function searchNav(type, idx) {
    document.getElementById('searchResultsDropdown').classList.add('hidden');
    document.getElementById('globalSearchInput').value = '';

    if (type === 'task' && _lastSearchTasks[idx]) {
        _lastSearchTasks[idx].action();
    } else if (type === 'sub' && _lastSearchSubs[idx]) {
        _lastSearchSubs[idx].action();
    }
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    const notifWrapper = document.getElementById('notifBellWrapper');
    const profileWrapper = document.getElementById('profileWrapper');
    if (notifWrapper && !notifWrapper.contains(e.target)) {
        document.getElementById('notifDropdown').classList.add('hidden');
    }
    if (profileWrapper && !profileWrapper.contains(e.target)) {
        document.getElementById('profileDropdown').classList.add('hidden');
    }
});

function toggleNotifDropdown() {
    const dd = document.getElementById('notifDropdown');
    dd.classList.toggle('hidden');
    // Close profile dropdown
    document.getElementById('profileDropdown').classList.add('hidden');
    // Re-render notifications when opening
    if (!dd.classList.contains('hidden')) {
        renderNotifDropdown();
    }
}

function toggleProfileDropdown() {
    const dd = document.getElementById('profileDropdown');
    dd.classList.toggle('hidden');
    // Update user info
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    document.getElementById('profileName').innerText = user.name || 'User';
    document.getElementById('profileEmail').innerText = user.email || '';
    // Close notif dropdown
    document.getElementById('notifDropdown').classList.add('hidden');
}

function startNotificationChecker() {
    if (notificationInterval) return; // already running
    // Check every 30 seconds
    notificationInterval = setInterval(() => {
        fetchLiveNotifications().then(() => renderNotifDropdown());
        checkTaskNotifications();
        checkReminderNotifications();
    }, 30000);
}

// Called after any data fetch completes to refresh notifications
function refreshNotifications() {
    fetchLiveNotifications().then(() => renderNotifDropdown());
    checkTaskNotifications();
    checkReminderNotifications();
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('mobileOverlay');
    sidebar.classList.toggle('-translate-x-full');
    overlay.classList.toggle('hidden');
}

function checkAuth() {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user') || '{}');

    if (!token) {
        document.getElementById('authModal').classList.remove('hidden');
        document.getElementById('appLayout').classList.add('hidden');
    } else {
        document.getElementById('authModal').classList.add('hidden');
        const appLayout = document.getElementById('appLayout');
        appLayout.classList.remove('hidden');
        appLayout.classList.add('fade-in');
        document.getElementById('userNameDisplay').innerText = user.name || 'User';
        refreshDashboard();
        filterView('all'); // Default to Dashboard view
        startNotificationChecker();
        // Request push notification permission and subscribe
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') subscribeToPush();
            });
        } else if ('Notification' in window && Notification.permission === 'granted') {
            subscribeToPush();
        }
    }
}

function switchAuthTab(mode) {
    currentAuthMode = mode;
    const nameGroup = document.getElementById('nameGroup');
    const title = document.getElementById('authTitle');
    const subtitle = document.getElementById('authSubtitle');
    const btn = document.getElementById('authSubmitBtn');
    const tabLogin = document.getElementById('tabLogin');
    const tabRegister = document.getElementById('tabRegister');

    if (mode === 'register') {
        nameGroup.classList.remove('hidden');
        title.innerText = 'Create Account';
        subtitle.innerText = 'Sign up to start managing your company dashboard';
        document.getElementById('authBtnText').innerText = 'Sign Up';
        tabRegister.className = "flex-1 py-1.5 rounded-lg bg-white text-orange-500 shadow-sm";
        tabLogin.className = "flex-1 py-1.5 rounded-lg text-slate-500";
    } else {
        nameGroup.classList.add('hidden');
        title.innerText = 'Welcome Back';
        subtitle.innerText = 'Please log in to access your company workspace';
        document.getElementById('authBtnText').innerText = 'Log In';
        tabLogin.className = "flex-1 py-1.5 rounded-lg bg-white text-orange-500 shadow-sm";
        tabRegister.className = "flex-1 py-1.5 rounded-lg text-slate-500";
    }
}

function openChangePasswordModal() {
    document.getElementById('changePasswordModal').classList.remove('hidden');
    document.getElementById('changePasswordForm').reset();
    document.getElementById('changePasswordError').classList.add('hidden');
    document.getElementById('changePasswordSuccess').classList.add('hidden');
    // Close the profile dropdown
    document.getElementById('profileDropdown').classList.add('hidden');
}

function closeChangePasswordModal() {
    document.getElementById('changePasswordModal').classList.add('hidden');
}

// Handle change password form submission
document.addEventListener('DOMContentLoaded', () => {
    const cpForm = document.getElementById('changePasswordForm');
    if (cpForm) {
        cpForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const errEl = document.getElementById('changePasswordError');
            const successEl = document.getElementById('changePasswordSuccess');
            errEl.classList.add('hidden');
            successEl.classList.add('hidden');

            const current = document.getElementById('currentPassword').value;
            const newPass = document.getElementById('newPassword').value;
            const confirm = document.getElementById('confirmPassword').value;

            if (newPass !== confirm) {
                errEl.innerText = 'New passwords do not match.';
                errEl.classList.remove('hidden');
                return;
            }

            if (newPass.length < 6) {
                errEl.innerText = 'New password must be at least 6 characters.';
                errEl.classList.remove('hidden');
                return;
            }

            try {
                const res = await apiFetch('/api/auth/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ currentPassword: current, newPassword: newPass })
                });

                const data = await res.json();

                if (res.ok) {
                    successEl.innerText = 'Password updated successfully!';
                    successEl.classList.remove('hidden');
                    document.getElementById('changePasswordForm').reset();
                    showToast('Password Changed', 'Your password has been updated.', 'success');
                    setTimeout(closeChangePasswordModal, 1500);
                } else {
                    errEl.innerText = data.error || 'Failed to change password.';
                    errEl.classList.remove('hidden');
                }
            } catch (err) {
                errEl.innerText = 'Network error. Try again.';
                errEl.classList.remove('hidden');
            }
        });
    }
});

let allReminders = [];
let currentReminderFilter = 'pending';

async function fetchDashboardReminders() {
    try {
        const res = await apiFetch('/api/reminders');
        if (res.ok) {
            allReminders = await res.json();
            renderDashboardReminders(allReminders);
            refreshNotifications();
        }
    } catch (err) { /* silent */ }
}

function renderDashboardReminders(reminders) {
    var list = document.getElementById('dashboardRemindersList');
    if (!list) return;

    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var weekFromNow = new Date(todayStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    var upcoming = reminders.filter(function(r) {
        if (r.status === 'completed') return false;
        var rd = parseDate(r.reminder_date);
        if (isNaN(rd.getTime())) return false;
        // Show reminders from today (start of day) through next 7 days
        var rdDateOnly = new Date(rd.getFullYear(), rd.getMonth(), rd.getDate());
        return rdDateOnly >= todayStart && rdDateOnly <= weekFromNow;
    });

    if (upcoming.length === 0) {
        list.innerHTML = '<li class="p-4 text-center text-slate-400 text-xs">No reminders in the next 7 days</li>';
        return;
    }

    list.innerHTML = '';
    for (var i = 0; i < upcoming.length; i++) {
        var r = upcoming[i];
        var d = parseDate(r.reminder_date);
        var dateStr = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        var timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        var todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var reminderDayOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var diffMs = reminderDayOnly - todayOnly;
        var diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

        var isPast = d < now;

        var bgColor = 'bg-amber-50 border-l-amber-500';
        if (isPast) bgColor = 'bg-red-50 border-l-red-500';
        else if (r.priority === 'high') bgColor = 'bg-red-50 border-l-red-500';
        else if (r.priority === 'low') bgColor = 'bg-blue-50 border-l-blue-500';

        var dayLabel;
        var badgeBg;
        if (isPast) {
            dayLabel = diffDays === 0 ? 'Missed' : 'Overdue';
            badgeBg = 'bg-red-100 text-red-700';
        } else {
            dayLabel = diffDays === 0 ? 'Today' : diffDays === 1 ? 'Tomorrow' : diffDays + ' days left';
            badgeBg = diffDays <= 1 ? 'bg-red-100 text-red-700' : diffDays <= 3 ? 'bg-orange-100 text-orange-700' : 'bg-blue-50 text-blue-700';
        }

        var item = '<li class="p-3 ' + bgColor + ' border-l-[3px] rounded shadow-sm flex justify-between items-center">';
        item += '<div>';
        item += '<div class="flex items-center gap-2">';
        item += '<strong class="text-gray-800 text-sm">' + r.title + '</strong>';
        item += '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full ' + badgeBg + '">' + dayLabel + '</span>';
        item += '</div>';
        if (r.description) item += '<p class="text-xs font-semibold text-slate-600 mt-0.5">' + r.description + '</p>';
        item += '<p class="text-xs text-gray-500 mt-0.5">' + dateStr + ' ' + timeStr + '</p>';
        item += '</div>';
        item += '<div class="flex items-center gap-1.5 shrink-0 ml-2">';
        item += '<button onclick="completeReminderAndRefresh(' + r.id + ')" title="Mark Done" class="text-[10px] bg-emerald-500 text-white font-semibold px-2 py-1.5 rounded-lg hover:bg-emerald-600 shadow-sm">✓ Done</button>';
        item += '<button onclick="deleteReminderAndRefresh(' + r.id + ')" title="Delete" class="text-[10px] bg-red-500 text-white font-semibold px-2 py-1.5 rounded-lg hover:bg-red-600 shadow-sm">🗑️</button>';
        item += '</div>';
        item += '</li>';
        list.innerHTML += item;
    }
}

async function fetchReminders() {
    try {
        const res = await apiFetch('/api/reminders');
        if (res.ok) {
            allReminders = await res.json();
            renderRemindersList();
        }
    } catch (err) { /* silent */ }
}

function renderRemindersList() {
    var list = document.getElementById('remindersFullList');
    var countEl = document.getElementById('reminderCount');
    if (!list) return;

    // Apply filter
    var filtered = allReminders;
    if (currentReminderFilter === 'pending') {
        filtered = allReminders.filter(r => r.status !== 'completed');
    } else if (currentReminderFilter === 'completed') {
        filtered = allReminders.filter(r => r.status === 'completed');
    }

    if (countEl) countEl.textContent = filtered.length + ' reminder' + (filtered.length !== 1 ? 's' : '');

    if (filtered.length === 0) {
        list.innerHTML = '<div class="p-6 text-center text-slate-400 text-xs">' + (allReminders.length === 0 ? 'No reminders yet. Add one!' : 'No ' + currentReminderFilter + ' reminders') + '</div>';
        return;
    }

    var html = '';
    for (var i = 0; i < filtered.length; i++) {
        var r = filtered[i];
        var d = parseDate(r.reminder_date);
        var dateStr = isNaN(d.getTime()) ? (r.reminder_date || '') : d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
        var timeStr = isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        var isCompleted = r.status === 'completed';
        var isPast = !isNaN(d.getTime()) && d < new Date() && !isCompleted;

        var bgColor = 'bg-amber-50 text-amber-600 border-l-amber-500';
        if (isCompleted) bgColor = 'bg-slate-50 border-l-slate-300 opacity-60';
        else if (isPast) bgColor = 'bg-red-50 border-l-red-500';
        else if (r.priority === 'high') bgColor = 'bg-red-50 text-red-600 border-l-red-500';
        else if (r.priority === 'low') bgColor = 'bg-blue-50 text-blue-600 border-l-blue-500';

        html += '<div class="flex items-start gap-3 ' + bgColor + ' border-l-[3px] rounded-lg p-3">';
        html += '<div class="flex-1 min-w-0">';
        html += '<p class="text-xs font-bold text-slate-800 ' + (isCompleted ? 'line-through' : '') + '">' + r.title + '</p>';
        if (r.description) html += '<p class="text-xs font-semibold text-slate-600 mt-0.5">' + r.description + '</p>';
        html += '<p class="text-[10px] text-slate-400 mt-1">' + dateStr + ' ' + timeStr + '</p>';
        html += '</div>';
        html += '<div class="flex items-center gap-1.5 shrink-0">';
        if (!isCompleted) html += '<button onclick="completeReminder(' + r.id + ')" class="text-[10px] bg-emerald-500 text-white font-bold px-2 py-1 rounded-lg hover:bg-emerald-600">Done</button>';
        html += '<button onclick="deleteReminder(' + r.id + ')" class="text-[10px] bg-red-500 text-white font-bold px-2 py-1 rounded-lg hover:bg-red-600">Delete</button>';
        html += '</div>';
        html += '</div>';
    }
    list.innerHTML = html;
}

async function completeReminder(id) {
    const confirmed = await showConfirmModal('Complete Reminder?', 'This reminder will be marked as done.', '✅', 'Yes, Complete', 'bg-emerald-500 hover:bg-emerald-600');
    if (!confirmed) return;
    const res = await apiFetch('/api/reminders/' + id + '/complete', { method: 'PUT' });
    if (res.ok) { showToast('Reminder Completed', 'Reminder marked as done.', 'success'); fetchReminders(); }
    else { const err = await res.json().catch(() => ({})); showToast('Error', err.error || 'Failed to complete reminder.', 'error'); }
}

async function deleteReminder(id) {
    const confirmed = await showConfirmModal('Delete Reminder?', 'This action cannot be undone.', '🗑️', 'Yes, Delete', 'bg-red-500 hover:bg-red-600');
    if (!confirmed) return;
    const res = await apiFetch('/api/reminders/' + id, { method: 'DELETE' });
    if (res.ok) { showToast('Reminder Deleted', 'Reminder has been removed.', 'warning'); fetchReminders(); }
}

async function completeReminderAndRefresh(id) {
    await completeReminder(id);
    fetchDashboardReminders();
    fetchLiveNotifications();
}

async function deleteReminderAndRefresh(id) {
    await deleteReminder(id);
    fetchDashboardReminders();
    fetchLiveNotifications();
}

async function logout() {
    document.getElementById('profileDropdown').classList.add('hidden');
    const confirmed = await showConfirmModal(
        'Confirm Logout',
        'Are you sure you want to log out?',
        '🚪',
        'Log Out',
        'bg-red-500 hover:bg-red-600'
    );
    if (!confirmed) return;
    // Unsubscribe from push notifications on logout
    unsubscribeFromPush();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('notifiedReminders');
    location.reload();
}

// Push Notification Subscription
async function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
        const res = await apiFetch('/api/push/vapid-key');
        const { publicKey } = await res.json();
        if (!publicKey) return;

        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey)
        });

        await apiFetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription })
        });
        console.log('Push notification subscribed.');
    } catch (err) {
        console.log('Push subscription skipped:', err.message);
    }
}

async function unsubscribeFromPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
            await apiFetch('/api/push/unsubscribe', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
            await subscription.unsubscribe();
        }
    } catch (err) {
        console.log('Push unsubscribe error:', err.message);
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// 4. Dashboard Data Fetching & Rendering
function refreshDashboard() {
    fetchAnalytics();
    fetchTasks();
    fetchProjects();
    fetchDashboardReminders();
}

async function fetchAnalytics() {
    const res = await apiFetch('/api/analytics');
    const data = await res.json();

    const completed = data.completedTasks || 0;
    const activeSoftware = data.activeSoftware || 0;

    // Note: pending and overdue counts are set by fetchTasks() client-side
    // to avoid timezone mismatch (server UTC NOW() vs client local time)
    document.getElementById('statCompleted').innerText = completed;
    document.getElementById('statActiveSoftware').innerText = activeSoftware;
}

async function fetchTasks() {
    const res = await apiFetch('/api/tasks');
    allTasks = await res.json();
    window.tasksList = allTasks.map(t => ({
        ...t,
        task_date: t.due_date,
        completed: t.status === 'completed'
    }));
    renderTasks();
    renderDashboardTasks();
    if (typeof renderUpcomingSchedule === 'function') renderUpcomingSchedule();
    refreshNotifications();

    // Fix overdue count: server uses NOW() in UTC but due_dates are stored in local time.
    // Recalculate client-side using isOverdue() so stat card matches the dashboard.
    const overdueCount = allTasks.filter(t => isOverdue(t)).length;
    document.getElementById('statOverdueTasks').innerText = overdueCount;
    const pendingCount = allTasks.filter(t => t.status === 'pending').length;
    document.getElementById('statPendingTasks').innerText = pendingCount;
}

function isOverdue(task) {
    if (task.status !== 'pending' || !task.due_date) return false;
    const due = parseDate(task.due_date);
    if (isNaN(due.getTime())) return false;
    const now = new Date();
    // Task is overdue if its due date+time has passed
    return due.getTime() < now.getTime();
}

// --- Notification System ---
const notifiedTasks = new Set();
let notificationCount = 0;

function playNotificationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        // Play a pleasant two-tone chime
        [0, 0.15].forEach((delay, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = i === 0 ? 880 : 1100;
            gain.gain.setValueAtTime(0.3, ctx.currentTime + delay);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.3);
            osc.start(ctx.currentTime + delay);
            osc.stop(ctx.currentTime + delay + 0.3);
        });
    } catch (e) {
        // Audio not available, skip
    }
}

function showBrowserNotification(title, body, icon) {
    if ('Notification' in window && Notification.permission === 'granted') {
        try {
            new Notification(title, { body: body, icon: icon || undefined });
        } catch (e) { /* browser notification not available */ }
    }
}

function updateBellBadge(count) {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 9 ? '9+' : count;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

async function fetchLiveNotifications() {
    try {
        const res = await apiFetch('/api/notifications');
        const alerts = await res.json();
        
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        const now = new Date();
        liveNotifications = [];

        // 1. Add renewal alerts from API
        if (alerts && alerts.length > 0) {
            alerts.forEach(a => {
                let urgency = 'info';
                let icon = '🔔';
                if (a.days_left < 0) { urgency = 'critical'; icon = '🔴'; }
                else if (a.days_left === 0) { urgency = 'critical'; icon = '🟡'; }
                else if (a.days_left <= 1) { urgency = 'critical'; icon = '🔴'; }
                else if (a.days_left <= 7) { urgency = 'high'; icon = '🟠'; }
                else if (a.days_left <= 15) { urgency = 'medium'; icon = '🟡'; }
                else { urgency = 'low'; icon = '🔔'; }

                const dayText = a.days_left < 0 
                    ? `Overdue by ${Math.abs(a.days_left)} day(s)` 
                    : a.days_left === 0 ? 'Due TODAY!' : `Renews in ${a.days_left} day(s)`;

                liveNotifications.push({
                    type: 'renewal',
                    title: `${a.software_name}`,
                    message: dayText,
                    icon: icon,
                    urgency: urgency,
                    date: a.next_renewal_date
                });
            });
        }

        // 2. Add overdue tasks
        if (allTasks && Array.isArray(allTasks)) {
            allTasks.forEach(task => {
                if (isOverdue(task)) {
                    liveNotifications.push({
                        type: 'overdue_task',
                        title: task.title,
                        message: `Overdue — was due ${formatDate(task.due_date)}`,
                        icon: '🔴',
                        urgency: 'high',
                        date: task.due_date
                    });
                }
                // Tasks due today or tomorrow
                else if (task.status === 'pending' && task.due_date) {
                    const due = parseDate(task.due_date);
                    const diffDays = Math.floor((due - new Date(now.toDateString())) / (1000 * 60 * 60 * 24));
                    if (diffDays === 0) {
                        liveNotifications.push({
                            type: 'task_today',
                            title: task.title,
                            message: 'Due today',
                            icon: '🟡',
                            urgency: 'medium',
                            date: task.due_date
                        });
                    } else if (diffDays === 1) {
                        liveNotifications.push({
                            type: 'task_tomorrow',
                            title: task.title,
                            message: 'Due tomorrow',
                            icon: '🟠',
                            urgency: 'medium',
                            date: task.due_date
                        });
                    }
                }
            });
        }

        // 3. Add overdue reminders
        if (allReminders && Array.isArray(allReminders)) {
            allReminders.forEach(function(r) {
                if (r.status === 'completed') return;
                var rd = parseDate(r.reminder_date);
                if (isNaN(rd.getTime())) return;
                if (rd < now) {
                    liveNotifications.push({
                        type: 'overdue_reminder',
                        title: r.title,
                        message: 'Reminder missed — was due ' + formatDateTime(r.reminder_date),
                        icon: '🔴',
                        urgency: 'high',
                        date: r.reminder_date
                    });
                }
            });
        }

        // 4. Add upcoming renewals (30/15/7/1 days) from projects
        if (allProjects && Array.isArray(allProjects)) {
            allProjects.forEach(proj => {
                if (!proj.next_renewal_date) return;
                if (proj.status !== 'active') return;
                const due = parseDate(proj.next_renewal_date);
                const now = new Date();
                const diffDays = Math.ceil((due - new Date(now.toDateString())) / (1000 * 60 * 60 * 24));
                if ([30, 15, 7, 1].includes(diffDays)) {
                    const exists = liveNotifications.find(n => n.type === 'renewal' && n.title === proj.software_name);
                    if (!exists) {
                        liveNotifications.push({
                            type: 'renewal_upcoming',
                            title: proj.software_name,
                            message: `Renews in ${diffDays} day(s)`,
                            icon: diffDays <= 7 ? '🟠' : '🔔',
                            urgency: diffDays <= 7 ? 'high' : 'medium',
                            date: proj.next_renewal_date
                        });
                    }
                }
            });
        }

        // Sort by urgency
        const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        liveNotifications.sort((a, b) => (urgencyOrder[a.urgency] || 4) - (urgencyOrder[b.urgency] || 4));
        // Filter out dismissed notifications
        const dismissed = getDismissedNotifications();
        liveNotifications = liveNotifications.filter(n => {
            const id = getNotificationId(n);
            return !dismissed.some(d => d.id === id);
        });
        // Update badge
        updateBellBadge(liveNotifications.length);
        // Play sound and show alerts if new notifications arrived
        if (liveNotifications.length > prevNotifCount && prevNotifCount > 0) {
            playNotificationSound();
            // Show browser notification for new items
            var newCount = liveNotifications.length - prevNotifCount;
            var summary = newCount === 1 ? liveNotifications[0].icon + ' ' + liveNotifications[0].title + ': ' + liveNotifications[0].message
                : newCount + ' new notifications';
            showBrowserNotification('Task Reminder', summary);
            // Also show in-app toast
            showToast('New Alert', summary, 'warning');
        }
        prevNotifCount = liveNotifications.length;

        // Render the dropdown list
        renderNotifDropdown();
    } catch (err) {
        // Silently fail — notifications are non-critical
    }
}

function renderNotifDropdown() {
    const list = document.getElementById('notifList');
    if (!list) return;

    if (liveNotifications.length === 0) {
        list.innerHTML = '<div class="p-6 text-center text-slate-400 text-xs">No notifications 🎉</div>';
        return;
    }

    list.innerHTML = liveNotifications.map((n, idx) => {
        const borderClass = n.urgency === 'critical' ? 'border-l-4 border-l-red-500' 
            : n.urgency === 'high' ? 'border-l-4 border-l-orange-500' 
            : '';
        return `
            <div class="p-3 hover:bg-slate-50 cursor-pointer transition-all ${borderClass}">
                <div class="flex items-start gap-2.5">
                    <span class="text-sm mt-0.5 shrink-0">${n.icon}</span>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-slate-800 truncate">${n.title}</p>
                        <p class="text-[10px] text-slate-500 mt-0.5">${n.message}</p>
                    </div>
                    <button onclick="event.stopPropagation(); dismissNotification(liveNotifications[${idx}])" class="text-slate-300 hover:text-red-500 text-xs shrink-0 mt-0.5" title="Dismiss">✕</button>
                </div>
            </div>
        `;
    }).join('');
}

function clearNotifications() {
    // Persist all current notifications as dismissed
    const dismissed = getDismissedNotifications();
    liveNotifications.forEach(n => {
        const id = getNotificationId(n);
        if (!dismissed.some(d => d.id === id)) {
            dismissed.push({ id: id, ts: Date.now() });
        }
    });
    saveDismissedNotifications(dismissed);
    liveNotifications = [];
    prevNotifCount = 0;
    updateBellBadge(0);
    renderNotifDropdown();
}

function checkTaskNotifications() {
    if (!allTasks || !Array.isArray(allTasks)) return;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    allTasks.forEach(task => {
        if (task.status !== 'completed' && task.due_date) {
            const due = parseDate(task.due_date);
            const dueMinutes = due.getHours() * 60 + due.getMinutes();
            // Use local date strings (not toISOString which converts to UTC)
            const dueDateStr = `${due.getFullYear()}-${String(due.getMonth()+1).padStart(2,'0')}-${String(due.getDate()).padStart(2,'0')}`;
            const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

            // Check if this task is due right now (same date, within 1 minute)
            if (dueDateStr === todayStr && Math.abs(dueMinutes - currentMinutes) <= 1 && !notifiedTasks.has(task.id)) {
                notifiedTasks.add(task.id);
                playNotificationSound();
                showBrowserNotification('⏰ Task Due Now!', `${task.title} is due at ${due.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`);
                showToast('⏰ Task Due Now!', `"${task.title}" is due now`, 'warning');
            }
            // Also alert for overdue tasks that haven't been notified
            else if (isOverdue(task) && !notifiedTasks.has('overdue-' + task.id)) {
                notifiedTasks.add('overdue-' + task.id);
                playNotificationSound();
                showBrowserNotification('🔴 Task Overdue!', `${task.title} was due ${formatDate(task.due_date)}`);
                showToast('🔴 Task Overdue!', `${task.title} was due ${formatDate(task.due_date)}`, 'error');
            }
        }
    });
}

// Check if any reminders have reached their alert time
const notifiedReminders = new Set(JSON.parse(localStorage.getItem('notifiedReminders') || '[]'));

function saveNotifiedReminders() {
    localStorage.setItem('notifiedReminders', JSON.stringify([...notifiedReminders]));
}

function checkReminderNotifications() {
    if (!allReminders || !Array.isArray(allReminders)) return;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    allReminders.forEach(r => {
        if (r.status === 'completed' || !r.reminder_date) return;
        if (notifiedReminders.has(r.id)) return;

        const rd = parseDate(r.reminder_date);
        if (isNaN(rd.getTime())) return;

        const rdDateStr = `${rd.getFullYear()}-${String(rd.getMonth()+1).padStart(2,'0')}-${String(rd.getDate()).padStart(2,'0')}`;
        const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

        // Alert when reminder is due right now (same date, within 1 minute)
        if (rdDateStr === todayStr) {
            const rdMinutes = rd.getHours() * 60 + rd.getMinutes();
            if (Math.abs(rdMinutes - currentMinutes) <= 1) {
                notifiedReminders.add(r.id);
                saveNotifiedReminders();
                playNotificationSound();
                showBrowserNotification('🔔 Reminder!', r.title);
                showToast('🔔 Reminder!', r.title, 'warning');
            }
        }
        // Alert once for overdue reminders
        else if (rd < now) {
            notifiedReminders.add(r.id);
            saveNotifiedReminders();
            playNotificationSound();
            showBrowserNotification('🔴 Reminder Missed!', `${r.title} was due ${formatDateTime(r.reminder_date)}`);
            showToast('🔴 Reminder Missed!', r.title, 'error');
        }
    });
}

function renderDashboardTasks(filter) {
    const list = document.getElementById('dashboardTaskList');
    if (!list) return;

    let tasks;
    if (filter === 'completed') {
        tasks = allTasks.filter(t => t.status === 'completed');
    } else if (filter === 'overdue') {
        tasks = allTasks.filter(t => isOverdue(t));
    } else if (filter === 'subscriptions') {
        // Don't show tasks, handled elsewhere
        list.innerHTML = '';
        return;
    } else {
        tasks = allTasks.filter(t => t.status === 'pending');
    }

    if (tasks.length === 0) {
        list.innerHTML = '<li class="p-4 text-center text-slate-400 text-xs">No matching tasks 🎉</li>';
        return;
    }
    list.innerHTML = tasks.map(task => {
        const date = formatDate(task.due_date);
        const hasTime = task.due_date && (task.due_date.includes(' ') || task.due_date.includes('T'));
        const timeStr = hasTime ? ' ' + formatDateTime(task.due_date).split(' ').slice(-2).join(' ') : '';

        // Determine color and badge based on urgency
        const now = new Date();
        const due = parseDate(task.due_date);
        const diffMs = due.getTime() - now.getTime();
        const diffMin = diffMs / (1000 * 60);

        let bgColor = '';
        let badge = '';
        let badgeBg = '';

        if (isOverdue(task)) {
            bgColor = 'bg-red-50 border-l-[3px] border-l-red-500 rounded shadow-sm';
            badge = 'Missed';
            badgeBg = 'bg-red-100 text-red-700';
        } else if (diffMin >= 0 && diffMin <= 60) {
            bgColor = 'bg-yellow-50 border-l-[3px] border-l-yellow-500 rounded shadow-sm';
            badge = 'Due soon';
            badgeBg = 'bg-yellow-100 text-yellow-700';
        }

        return `
            <li class="p-3 flex items-center justify-between ${bgColor}">
                <div>
                    <div class="flex items-center gap-2">
                        <p class="text-xs font-bold text-slate-800">${task.title}</p>
                        ${badge ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full ' + badgeBg + '">' + badge + '</span>' : ''}
                    </div>
                    <span class="text-xs font-semibold text-slate-600">${task.description || ''} &middot; ${date}${timeStr}</span>
                </div>
                <button onclick="completeTask(${task.id})" class="text-[10px] bg-emerald-500 text-white font-bold px-2.5 py-1 rounded-lg hover:bg-emerald-600 transition-all">
                    ✓ Completed
                </button>
            </li>
        `;
    }).join('');
}

function renderTasks() {
    const list = document.getElementById('taskList');
    const pagContainer = document.getElementById('taskPagination');
    
    const filtered = allTasks.filter(task => {
        const matchesStatus = currentTaskFilter === 'all' 
            || (currentTaskFilter === 'pending' && task.status === 'pending')
            || (currentTaskFilter === 'completed' && task.status === 'completed')
            || (currentTaskFilter === 'overdue' && isOverdue(task));

        return matchesStatus;
    });

    // Pagination
    const totalPages = Math.ceil(filtered.length / taskPageSize) || 1;
    if (taskCurrentPage > totalPages) taskCurrentPage = totalPages;
    if (taskCurrentPage < 1) taskCurrentPage = 1;
    const startIdx = (taskCurrentPage - 1) * taskPageSize;
    const paged = filtered.slice(startIdx, startIdx + taskPageSize);

    list.innerHTML = '';

    if (paged.length === 0) {
        list.innerHTML = '<li class="text-gray-400 text-sm p-2">No matching tasks found.</li>';
    } else {
        paged.forEach(task => {
            const date = formatDate(task.due_date);
            const hasTime = task.due_date && (task.due_date.includes(' ') || task.due_date.includes('T'));
            const timeStr = hasTime ? ' ' + formatDateTime(task.due_date).split(' ').slice(-2).join(' ') : '';
            const isCompleted = task.status === 'completed';
            
            list.innerHTML += `
                <li class="p-3 bg-gray-50 border-l-4 ${isCompleted ? 'border-gray-400 opacity-60' : 'border-blue-500'} rounded shadow-sm flex justify-between items-center">
                    <div>
                        <strong class="text-gray-800 ${isCompleted ? 'line-through' : ''}">${task.title}</strong>
                        <p class="text-sm font-semibold text-slate-700 ${isCompleted ? 'line-through' : ''}">${task.description || ''}</p>
                        <span class="text-xs font-bold text-gray-400">${date}${timeStr}</span>
                    </div>
                    <div class="flex items-center gap-2">
                        ${!isCompleted ? `
                            <button onclick="completeTask(${task.id})" class="text-xs bg-blue-600 text-white font-semibold px-2 py-1 rounded hover:bg-blue-700">
                                ✓ Complete
                            </button>
                        ` : '<span class="text-xs text-green-600 font-bold">Done</span>'}
                        <button onclick="deleteTask(${task.id})" class="text-xs bg-red-500 text-white font-semibold px-2 py-1 rounded hover:bg-red-600">
                            🗑️ Delete
                        </button>
                    </div>
                </li>
            `;
        });
    }

    // Render pagination controls
    renderTaskPagination(filtered.length, totalPages);
}

function renderTaskPagination(totalItems, totalPages) {
    const container = document.getElementById('taskPagination');
    if (!container) return;

    if (totalItems <= taskPageSize) {
        container.innerHTML = `<span class="text-[10px] text-slate-400">Showing ${totalItems} of ${totalItems} tasks</span>`;
        return;
    }

    const start = (taskCurrentPage - 1) * taskPageSize + 1;
    const end = Math.min(taskCurrentPage * taskPageSize, totalItems);

    let pageButtons = '';
    for (let i = 1; i <= totalPages; i++) {
        const isActive = i === taskCurrentPage;
        pageButtons += `<button onclick="goToTaskPage(${i})" class="w-7 h-7 rounded-lg text-[10px] font-bold ${isActive ? 'bg-orange-500 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'} transition-all">${i}</button>`;
    }

    container.innerHTML = `
        <span class="text-[10px] text-slate-400">Showing ${start}-${end} of ${totalItems}</span>
        <div class="flex items-center gap-1">
            <button onclick="goToTaskPage(${taskCurrentPage - 1})" ${taskCurrentPage <= 1 ? 'disabled' : ''} class="w-7 h-7 rounded-lg text-[10px] font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-all">◀</button>
            ${pageButtons}
            <button onclick="goToTaskPage(${taskCurrentPage + 1})" ${taskCurrentPage >= totalPages ? 'disabled' : ''} class="w-7 h-7 rounded-lg text-[10px] font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-all">▶</button>
        </div>
    `;
}

function goToTaskPage(page) {
    taskCurrentPage = page;
    renderTasks();
}

function setTaskFilter(status) {
    currentTaskFilter = status;
    taskCurrentPage = 1;

    ['All', 'Pending', 'Completed'].forEach(btn => {
        const el = document.getElementById(`filter${btn}`);
        if (!el) return;
        if (btn.toLowerCase() === status) {
            el.className = "px-3 py-1 rounded-lg bg-white shadow-sm text-slate-800 font-bold text-[10px]";
        } else {
            el.className = "px-3 py-1 rounded-lg text-slate-400 hover:text-slate-800 text-[10px]";
        }
    });

    renderTasks();
}

function setReminderFilter(status) {
    currentReminderFilter = status;
    ['All', 'Pending', 'Completed'].forEach(btn => {
        const el = document.getElementById('rFilter' + btn);
        if (!el) return;
        if (btn.toLowerCase() === status) {
            el.className = 'px-3 py-1 rounded-lg bg-white shadow-sm text-slate-800 font-bold text-[10px]';
        } else {
            el.className = 'px-3 py-1 rounded-lg text-slate-400 hover:text-slate-800 text-[10px]';
        }
    });
    renderRemindersList();
}

function highlightStatCard(type) {
    const cards = ['cardPending', 'cardOverdue', 'cardCompleted', 'cardSubscriptions'];
    const colorMap = {
        pending:     { border: 'border-blue-500', bg: 'bg-blue-50' },
        overdue:     { border: 'border-red-500', bg: 'bg-red-50' },
        completed:   { border: 'border-emerald-500', bg: 'bg-emerald-50' },
        subscriptions: { border: 'border-purple-500', bg: 'bg-purple-50' }
    };
    cards.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        // Reset to default
        el.className = 'bg-white p-4 rounded-2xl border border-slate-200/60 shadow-sm flex items-center justify-between cursor-pointer hover:shadow-md transition-all';
    });
    if (type && colorMap[type]) {
        const el = document.getElementById('card' + type.charAt(0).toUpperCase() + type.slice(1));
        if (el) {
            el.className = `bg-white p-4 rounded-2xl border-2 ${colorMap[type].border} shadow-md flex items-center justify-between cursor-pointer transition-all`;
        }
    }
}

function filterByStatCard(type) {
    highlightStatCard(type);

    if (type === 'subscriptions') {
        filterView('renewals');
        return;
    }

    // Switch to My Tasks view with the correct filter
    currentTaskFilter = type;
    taskCurrentPage = 1;
    filterView('tasks');

    // Sync the in-view filter buttons
    ['All', 'Pending', 'Completed'].forEach(btn => {
        const el = document.getElementById(`filter${btn}`);
        if (!el) return;
        if (btn.toLowerCase() === type) {
            el.className = 'px-3 py-1 rounded-lg bg-white shadow-sm text-slate-800 font-bold';
        } else {
            el.className = 'px-3 py-1 rounded-lg text-slate-400 hover:text-slate-800';
        }
    });

    renderTasks();
}

let _confirmResolve = null;

function showConfirmModal(title, message, icon, okText, okColorClass) {
    return new Promise((resolve) => {
        _confirmResolve = resolve;
        document.getElementById('confirmTitle').innerText = title;
        document.getElementById('confirmMessage').innerText = message;
        document.getElementById('confirmIcon').innerHTML = icon;
        document.getElementById('confirmIcon').className = 'w-14 h-14 rounded-full mx-auto mb-3 flex items-center justify-center text-2xl ' + (okColorClass ? 'bg-orange-100' : 'bg-red-100');
        const okBtn = document.getElementById('confirmOkBtn');
        okBtn.innerText = okText || 'Confirm';
        okBtn.className = 'flex-1 ' + (okColorClass || 'bg-orange-500 hover:bg-orange-600') + ' text-white font-bold px-4 py-2.5 rounded-xl text-xs shadow-sm transition-all';
        document.getElementById('confirmModal').classList.remove('hidden');
    });
}

function closeConfirmModal() {
    document.getElementById('confirmModal').classList.add('hidden');
    if (_confirmResolve) _confirmResolve(false);
    _confirmResolve = null;
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('confirmOkBtn').addEventListener('click', () => {
        document.getElementById('confirmModal').classList.add('hidden');
        if (_confirmResolve) _confirmResolve(true);
        _confirmResolve = null;
    });

    // Reminder form handler
    const reminderForm = document.getElementById('reminderForm');
    if (reminderForm) {
        reminderForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                title: document.getElementById('reminderTitle').value,
                description: document.getElementById('reminderDesc').value,
                reminder_date: document.getElementById('reminderDate').value,
                reminder_time: ampTo24(document.getElementById('reminderTimeHour').value, document.getElementById('reminderTimeMin').value, document.getElementById('reminderTimeAmpm').value),
                priority: document.getElementById('reminderPriority').value
            };
            const res = await apiFetch('/api/reminders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                showToast('Reminder Added', 'Your reminder has been saved.', 'success');
                reminderForm.reset();
                populateTimeSelects('reminderTimeHour', 'reminderTimeMin', 'reminderTimeAmpm', '09:00');
                fetchReminders();
            } else {
                const data = await res.json();
                showToast('Error', data.error || 'Failed to add reminder.', 'error');
            }
        });
    }
});

async function completeTask(id) {
    const confirmed = await showConfirmModal(
        'Mark as Completed?',
        'This task will be marked as done. You can undo this later.',
        '✅',
        'Yes, Complete',
        'bg-emerald-500 hover:bg-emerald-600'
    );
    if (!confirmed) return;
    const res = await apiFetch(`/api/tasks/${id}/complete`, { method: 'PUT' });
    if (res.ok) {
        showToast('Task Completed', 'Task has been marked as completed.', 'success');
        refreshDashboard();
    } else {
        const err = await res.json().catch(() => ({}));
        showToast('Error', err.error || 'Failed to complete task.', 'error');
    }
}

async function deleteTask(id) {
    const confirmed = await showConfirmModal(
        'Delete Task?',
        'This action cannot be undone. The task will be permanently removed.',
        '🗑️',
        'Yes, Delete',
        'bg-red-500 hover:bg-red-600'
    );
    if (!confirmed) return;
    const res = await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' });
    if (res.ok) {
        showToast('Task Deleted', 'Task has been removed.', 'warning');
        refreshDashboard();
    }
}

async function fetchProjects() {
    const res = await apiFetch('/api/projects');
    allProjects = await res.json();
    window.softwareList = allProjects;
    renderProjects();
    if (typeof renderUpcomingSchedule === 'function') renderUpcomingSchedule();
    refreshNotifications();
}function getDaysUntilRenewal(nextDate) {
    if (!nextDate) return Infinity;
    const now = new Date();
    const due = parseDate(nextDate);
    if (isNaN(due.getTime())) return Infinity;
    return Math.ceil((due - new Date(now.toDateString())) / (1000 * 60 * 60 * 24));
}

function renderProjects() {
    const list = document.getElementById('projectList');
    const activeList = document.getElementById('activeSubscriptionsList');
    const activeCount = document.getElementById('activeSubCount');
    const isDashboard = document.getElementById('subscriptionsSection')?.style.display !== 'none';
    
    // On dashboard, only show renewals within 30 days; on subscriptions page show all
    const projects = isDashboard 
        ? allProjects.filter(p => {
            if (p.status !== 'active') return false;
            const days = getDaysUntilRenewal(p.next_renewal_date);
            return days <= 30;
        })
        : allProjects;

    // Render all subscriptions list (subscriptions page only)
    if (activeList) {
        const activeProjects = allProjects.filter(p => p.status === 'active');
        const inactiveProjects = allProjects.filter(p => p.status !== 'active');
        if (activeCount) activeCount.textContent = activeProjects.length + ' active / ' + inactiveProjects.length + ' inactive';
        
        if (allProjects.length === 0) {
            activeList.innerHTML = '<li class="p-4 text-center text-slate-400 text-xs">No subscriptions yet.</li>';
        } else {
            activeList.innerHTML = '';
            // Render active subscriptions first
            activeProjects.forEach(proj => {
                const date = formatDate(proj.next_renewal_date);
                const days = getDaysUntilRenewal(proj.next_renewal_date);
                const launchDate = proj.launch_date ? formatDate(proj.launch_date) : 'N/A';

                let badgeBg = 'bg-slate-100 text-slate-600';
                if (days < 0) badgeBg = 'bg-red-100 text-red-700';
                else if (days <= 7) badgeBg = 'bg-orange-100 text-orange-700';
                else if (days <= 15) badgeBg = 'bg-yellow-100 text-yellow-700';
                else badgeBg = 'bg-blue-50 text-blue-700';
                const dayLabel = days < 0 ? 'Overdue' : days === 0 ? 'Due Today' : days + 'd left';

                activeList.innerHTML += `
                    <li class="p-3 bg-gray-50 border-l-4 border-l-green-400 rounded shadow-sm flex justify-between items-center">
                        <div>
                            <div class="flex items-center gap-2">
                                <strong class="text-gray-800 text-sm">${proj.software_name}</strong>
                                <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeBg}">${dayLabel}</span>
                                <span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">Active</span>
                            </div>
                            <p class="text-xs text-gray-500 mt-0.5">Cycle: ${proj.renewal_cycle} &middot; Launched: ${launchDate} &middot; Renews: ${date}</p>
                                ${(() => { const fUrl = authFileUrl(proj.file_path); if (!fUrl) return ""; const docLabel = proj.doc_type ? proj.doc_type.toUpperCase() : "DOC"; return "<a href=\"" + fUrl + "\" target=\"_blank\" class=\"text-[10px] text-blue-600 underline block mt-1\">📄 View " + docLabel + " (" + proj.file_name + ")</a>"; })()}
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0 ml-2">
                            <button onclick="toggleSubscriptionStatus(${proj.id}, 'inactive')" title="Deactivate" class="text-[10px] bg-amber-500 text-white font-semibold px-2 py-1.5 rounded-lg hover:bg-amber-600 shadow-sm">⏸ Pause</button>
                            <button onclick="openEditSubscription(${proj.id})" title="Edit" class="text-[10px] bg-blue-500 text-white font-semibold px-2 py-1.5 rounded-lg hover:bg-blue-600 shadow-sm">✏️ Edit</button>
                            <button onclick="viewPaymentHistory(${proj.id}, '${proj.software_name}')" class="text-[10px] bg-slate-600 text-white font-semibold px-2.5 py-1.5 rounded-lg hover:bg-slate-700 shadow-sm">📜 History</button>
                            <button onclick="renewSoftware(${proj.id})" class="text-[10px] bg-green-600 text-white font-semibold px-2.5 py-1.5 rounded-lg hover:bg-green-700 shadow-sm">✓ Mark Paid</button>
                        </div>
                    </li>
                `;
            });
            // Render inactive subscriptions
            inactiveProjects.forEach(proj => {
                const date = formatDate(proj.next_renewal_date);
                const launchDate = proj.launch_date ? formatDate(proj.launch_date) : 'N/A';

                activeList.innerHTML += `
                    <li class="p-3 bg-slate-50 border-l-4 border-l-slate-300 rounded shadow-sm flex justify-between items-center opacity-75">
                        <div>
                            <div class="flex items-center gap-2">
                                <strong class="text-gray-600 text-sm">${proj.software_name}</strong>
                                <span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600">Paused</span>
                            </div>
                            <p class="text-xs text-gray-400 mt-0.5">Cycle: ${proj.renewal_cycle} &middot; Launched: ${launchDate} &middot; Renews: ${date}</p>
                                ${(() => { const fUrl = authFileUrl(proj.file_path); if (!fUrl) return ""; const docLabel = proj.doc_type ? proj.doc_type.toUpperCase() : "DOC"; return "<a href=\"" + fUrl + "\" target=\"_blank\" class=\"text-[10px] text-blue-600 underline block mt-1\">📄 View " + docLabel + " (" + proj.file_name + ")</a>"; })()}
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0 ml-2">
                            <button onclick="toggleSubscriptionStatus(${proj.id}, 'active')" title="Activate" class="text-[10px] bg-green-500 text-white font-semibold px-2 py-1.5 rounded-lg hover:bg-green-600 shadow-sm">▶ Resume</button>
                            <button onclick="openEditSubscription(${proj.id})" title="Edit" class="text-[10px] bg-blue-500 text-white font-semibold px-2 py-1.5 rounded-lg hover:bg-blue-600 shadow-sm">✏️ Edit</button>
                            <button onclick="viewPaymentHistory(${proj.id}, '${proj.software_name}')" class="text-[10px] bg-slate-600 text-white font-semibold px-2.5 py-1.5 rounded-lg hover:bg-slate-700 shadow-sm">📜 History</button>
                        </div>
                    </li>
                `;
            });
        }
    }

    if (projects.length === 0) {
        list.innerHTML = isDashboard 
            ? '<p class="text-gray-400 text-xs p-2">No upcoming renewals within 30 days.</p>'
            : '<p class="text-gray-400 text-sm">No software subscriptions added.</p>';
        return;
    }
    list.innerHTML = '';
    
    projects.forEach(proj => {
        const date = formatDate(proj.next_renewal_date);
        const days = getDaysUntilRenewal(proj.next_renewal_date);
        
        // Urgency color coding
        let urgencyColor = 'text-slate-500';
        let borderColor = 'border-l-slate-300';
        let badgeBg = 'bg-slate-100 text-slate-600';
        if (days < 0) { urgencyColor = 'text-red-600'; borderColor = 'border-l-red-500'; badgeBg = 'bg-red-100 text-red-700'; }
        else if (days === 0) { urgencyColor = 'text-red-600'; borderColor = 'border-l-red-500'; badgeBg = 'bg-red-100 text-red-700'; }
        else if (days <= 7) { urgencyColor = 'text-orange-600'; borderColor = 'border-l-orange-500'; badgeBg = 'bg-orange-100 text-orange-700'; }
        else if (days <= 15) { urgencyColor = 'text-yellow-600'; borderColor = 'border-l-yellow-500'; badgeBg = 'bg-yellow-100 text-yellow-700'; }
        else { urgencyColor = 'text-blue-600'; borderColor = 'border-l-blue-400'; badgeBg = 'bg-blue-50 text-blue-700'; }
        const dayLabel = days < 0 
            ? `Overdue by ${Math.abs(days)}d` 
            : days === 0 ? 'Due Today' 
            : days === 1 ? 'Tomorrow' 
            : `${days} days left`;
        
        const fileUrl = proj.file_path && proj.file_path.startsWith("http") ? proj.file_path : "/uploads/" + proj.file_path;
        const documentLink = proj.file_path 
            ? `<a href="${fileUrl}" target="_blank" class="text-xs text-blue-600 underline block mt-1">
                📄 View ${proj.doc_type ? proj.doc_type.toUpperCase() : 'DOC'} (${proj.file_name})
               </a>` 
            : '';
        list.innerHTML += `
            <li class="p-3 bg-gray-50 border-l-4 ${borderColor} rounded shadow-sm flex justify-between items-center">
                <div>
                    <div class="flex items-center gap-2">
                        <strong class="text-gray-800 text-sm">${proj.software_name}</strong>
                        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeBg}">${dayLabel}</span>
                    </div>
                    <p class="text-xs text-gray-500 uppercase font-semibold mt-0.5">Cycle: ${proj.renewal_cycle} · Renews: ${date}</p>
                    ${documentLink}
                </div>
                <div class="flex items-center gap-1.5 shrink-0 ml-2">
                    <button onclick="viewPaymentHistory(${proj.id}, '${proj.software_name}')" class="text-[10px] bg-slate-600 text-white font-semibold px-2.5 py-1.5 rounded-lg hover:bg-slate-700 shadow-sm">
                        📜 History
                    </button>
                    <button onclick="renewSoftware(${proj.id})" class="text-[10px] bg-green-600 text-white font-semibold px-2.5 py-1.5 rounded-lg hover:bg-green-700 shadow-sm">
                        ✓ Mark Paid
                    </button>
                </div>
            </li>
        `;
    });
}

async function viewPaymentHistory(projectId, softwareName) {
    document.getElementById('modalTitle').innerText = `Payment History - ${softwareName}`;
    const res = await apiFetch(`/api/projects/${projectId}/payments`);
    const history = await res.json();
    
    const list = document.getElementById('paymentHistoryList');
    list.innerHTML = '';

    if (!history || history.length === 0) {
        list.innerHTML = '<tr><td colspan="4" class="p-3 text-center text-gray-400">No payment logs found.</td></tr>';
    } else {
        history.forEach(item => {
            const payDate = new Date(item.payment_date).toLocaleDateString();
            let docCell = '<td class="p-2 text-gray-400">—</td>';
            if (item.file_path) {
                const docLabel = item.doc_type ? item.doc_type.toUpperCase() : 'DOC';
                const fileUrl = authFileUrl(item.file_path);
                docCell = `<td class="p-2"><a href="${fileUrl}" target="_blank" class="text-blue-600 hover:underline text-[10px] font-semibold">📄 View ${docLabel}</a></td>`;
            }
            list.innerHTML += `
                <tr class="border-b">
                    <td class="p-2">${payDate}</td>
                    <td class="p-2 font-bold text-green-600">$${parseFloat(item.amount_paid).toFixed(2)}</td>
                    <td class="p-2 text-xs text-gray-500">${item.period_covered || 'N/A'}</td>
                    ${docCell}
                </tr>
            `;
        });
    }

    document.getElementById('paymentModal').classList.remove('hidden');
}

function closePaymentModal() {
    document.getElementById('paymentModal').classList.add('hidden');
}

function openEditSubscription(id) {
    const proj = allProjects.find(p => p.id === id);
    if (!proj) return;

    document.getElementById('editSubId').value = proj.id;
    document.getElementById('editSubName').value = proj.software_name;
    document.getElementById('editSubLaunch').value = proj.launch_date ? proj.launch_date.split('T')[0] : '';
    document.getElementById('editSubRenewal').value = proj.next_renewal_date ? proj.next_renewal_date.split('T')[0] : '';
    document.getElementById('editSubCycle').value = proj.renewal_cycle;
    document.getElementById('editSubDocType').value = proj.doc_type || '';
    document.getElementById('editSubError').classList.add('hidden');
    document.getElementById('editSubscriptionModal').classList.remove('hidden');
}

function closeEditSubscriptionModal() {
    document.getElementById('editSubscriptionModal').classList.add('hidden');
}

async function toggleSubscriptionStatus(id, newStatus) {
    try {
        const res = await apiFetch(`/api/projects/${id}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Status Updated', data.message, 'success');
            fetchProjects();
        } else {
            showToast('Error', data.error || 'Failed to update status', 'error');
        }
    } catch (err) {
        showToast('Error', 'Failed to update status', 'error');
    }
}

function renewSoftware(id) {
    const proj = allProjects.find(p => p.id === id);
    document.getElementById('renewProjectId').value = id;
    document.getElementById('renewModalTitle').innerText = `Renew - ${proj ? proj.software_name : 'Subscription'}`;

    // Pre-fill next renewal date based on cycle
    const nextDate = new Date();
    if (proj && proj.renewal_cycle === 'monthly') {
        nextDate.setMonth(nextDate.getMonth() + 1);
    } else {
        nextDate.setFullYear(nextDate.getFullYear() + 1);
    }
    document.getElementById('renewNextDate').value = nextDate.toISOString().split('T')[0];

    document.getElementById('renewAmount').value = '';
    document.getElementById('renewMethod').value = '';
    document.getElementById('renewNotes').value = '';
    document.getElementById('renewDoc').value = '';
    document.getElementById('renewModal').classList.remove('hidden');
}

function closeRenewModal() {
    document.getElementById('renewModal').classList.add('hidden');
}


function downloadCSV(url, filename) {
    const token = localStorage.getItem('token');
    if (!token) {
        alert('Please log in to export reports.');
        return;
    }
    fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
        .then(res => {
            if (!res.ok) throw new Error('Export failed. Please log in again.');
            return res.blob();
        })
        .then(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(a.href);
        })
        .catch(err => alert(err.message));
}

function filterView(sectionId) {
    // Grab every section by ID
    const el = {
        metrics:      document.getElementById('metricsGrid'),
        dashTasks:    document.getElementById('dashboardTasksSection'),
        subscriptions: document.getElementById('subscriptionsSection'),
        taskForm:     document.getElementById('tasks-section'),
        taskList:     document.getElementById('taskListSection'),
        swForm:       document.getElementById('software-section'),
        activeSubs:   document.getElementById('activeSubscriptionsSection'),
        reminders:    document.getElementById('reminders-section'),
        reports:      document.getElementById('reports-section'),
        rightSidebar: document.getElementById('rightSidebar'),
        dashReminders: document.getElementById('dashboardRemindersSection'),
    };

    // Helper to toggle visibility
    const show = (node, visible) => { if (!node) return; node.classList.toggle('hidden', !visible); };

    // Reset all nav buttons to inactive
    ['navAll', 'navTasks', 'navRenewals', 'navReminders', 'navReports'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.className = 'w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl font-bold text-xs text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-all';
    });

    // Highlight the active nav button
    const activeMap = { all: 'navAll', tasks: 'navTasks', renewals: 'navRenewals', reminders: 'navReminders', reports: 'navReports' };
    const activeBtn = document.getElementById(activeMap[sectionId]);
    if (activeBtn) activeBtn.className = 'w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl font-bold text-xs text-orange-500 bg-orange-50/80 border-r-4 border-orange-500 transition-all';

    // Apply visibility per section
    // DASHBOARD: stats + subscription list + alerts only (no forms)
    if (sectionId === 'all') {
        show(el.metrics, true);
        show(el.notifications, true);
        show(el.dashTasks, true);
        show(el.subscriptions, true);
        show(el.dashReminders, true);
        show(el.taskForm, false);
        show(el.taskList, false);
        show(el.swForm, false);
        show(el.activeSubs, false);
        show(el.reminders, false);
        show(el.reports, false);
        show(el.rightSidebar, true);
        highlightStatCard(null);
        renderDashboardTasks();
    }
    // MY TASKS: task form + task list only
    else if (sectionId === 'tasks') {
        show(el.metrics, false);
        show(el.notifications, false);
        show(el.dashTasks, false);
        show(el.subscriptions, false);
        show(el.dashReminders, false);
        show(el.rightSidebar, false);
        show(el.taskForm, true);
        show(el.taskList, true);
        show(el.swForm, false);
        show(el.activeSubs, false);
        show(el.reminders, false);
        show(el.reports, false);
    }
    // SUBSCRIPTIONS: subscription form + active subscriptions list
    else if (sectionId === 'renewals') {
        show(el.metrics, false);
        show(el.notifications, false);
        show(el.dashTasks, false);
        show(el.subscriptions, false);
        show(el.dashReminders, false);
        show(el.taskForm, false);
        show(el.taskList, false);
        show(el.rightSidebar, false);
        show(el.swForm, true);
        show(el.activeSubs, true);
        show(el.reminders, false);
        show(el.reports, false);
        renderProjects();
    }
    // REPORTS & EXPORT: reports only
    else if (sectionId === 'reports') {
        show(el.metrics, false);
        show(el.notifications, false);
        show(el.dashTasks, false);
        show(el.subscriptions, false);
        show(el.dashReminders, false);
        show(el.taskForm, false);
        show(el.taskList, false);
        show(el.rightSidebar, false);
        show(el.swForm, false);
        show(el.activeSubs, false);
        show(el.reminders, false);
        show(el.reports, true);
    }
    // REMINDERS: reminder form + reminders list
    else if (sectionId === 'reminders') {
        show(el.metrics, false);
        show(el.notifications, false);
        show(el.dashTasks, false);
        show(el.subscriptions, false);
        show(el.dashReminders, false);
        show(el.taskForm, false);
        show(el.taskList, false);
        show(el.swForm, false);
        show(el.activeSubs, false);
        show(el.rightSidebar, false);
        show(el.reminders, true);
        show(el.reports, false);
        fetchReminders();
    }
}