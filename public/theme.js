// Applied before the page paints so there is no flash of the wrong theme; dark is the default
document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark';
