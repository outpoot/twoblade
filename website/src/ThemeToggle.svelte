<script>
  import { onMount } from 'svelte';

  let isDark = false;

  // Load theme from localStorage or system preference
  onMount(() => {
    const saved = localStorage.getItem('theme');
    if (saved) {
      isDark = saved === 'dark';
    } else {
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    updateTheme();
  });

  function toggleTheme() {
    isDark = !isDark;
    updateTheme();
  }

  function updateTheme() {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }
</script>

<button on:click={toggleTheme} aria-label="Toggle theme" class="p-2 rounded bg-gray-200 dark:bg-gray-700 text-sm">
  {isDark ? '🌙 Dark' : '☀️ Light'}
</button>
