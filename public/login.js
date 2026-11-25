'use strict';
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const error = document.getElementById('error');
  const res = await fetch('/auth/dev-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: document.getElementById('role').value }),
  });
  if (res.ok) { location.href = '/'; return; }
  error.textContent = (await res.json().catch(() => ({}))).error || 'Sign-in failed';
  error.classList.remove('hidden');
});
