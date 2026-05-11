document.addEventListener('DOMContentLoaded', () => {
  const codeEditor = document.getElementById('codeEditor');
  const runBtn = document.getElementById('runBtn');
  const terminalOutput = document.getElementById('terminalOutput');
  const statusIndicator = document.getElementById('statusIndicator');

  // Basic indentation support for textarea
  codeEditor.addEventListener('keydown', function(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = this.selectionStart;
      const end = this.selectionEnd;
      
      // Set textarea value to: text before caret + 4 spaces + text after caret
      this.value = this.value.substring(0, start) +
        "    " + this.value.substring(end);
      
      // Put caret at right position again
      this.selectionStart = this.selectionEnd = start + 4;
    }
  });

  function setStatus(status, text) {
    statusIndicator.className = `status ${status}`;
    statusIndicator.textContent = text;
  }

  runBtn.addEventListener('click', async () => {
    const code = codeEditor.value;
    
    if (!code.trim()) return;

    // UI Updates
    runBtn.disabled = true;
    runBtn.innerHTML = '⚙️ Running...';
    terminalOutput.innerHTML = '<div class="output-line" style="color: var(--text-muted);">Provisioning sandbox and executing...</div>';
    setStatus('running', 'Running');

    try {
      const response = await fetch('/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code })
      });

      const data = await response.json();
      terminalOutput.innerHTML = ''; // clear

      if (!response.ok) {
        throw new Error(data.error || 'Unknown server error');
      }

      // Display stdout
      if (data.stdout) {
        const outDiv = document.createElement('div');
        outDiv.className = 'output-line';
        outDiv.textContent = data.stdout;
        terminalOutput.appendChild(outDiv);
      }

      // Display stderr
      if (data.stderr) {
        const errDiv = document.createElement('div');
        errDiv.className = 'output-line error-line';
        errDiv.textContent = data.stderr;
        terminalOutput.appendChild(errDiv);
      }

      // Display stats
      const statsDiv = document.createElement('div');
      statsDiv.className = 'execution-stats';
      statsDiv.textContent = `Exit Code: ${data.exitCode} • Execution Time: ${data.durationMS}ms`;
      terminalOutput.appendChild(statsDiv);

      setStatus(data.exitCode === 0 ? 'success' : 'error', data.exitCode === 0 ? 'Success' : 'Failed');

    } catch (err) {
      terminalOutput.innerHTML = `<div class="output-line error-line">Error: ${err.message}</div>`;
      setStatus('error', 'Error');
    } finally {
      runBtn.disabled = false;
      runBtn.innerHTML = 'Run Code';
    }
  });
});
