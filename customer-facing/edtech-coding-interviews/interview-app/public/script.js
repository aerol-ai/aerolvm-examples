const BOILERPLATES = {
  python: { ext: "main.py", monacoLang: "python", code: `def main():\n    print("Hello from Python in AerolVM!")\n\nif __name__ == "__main__":\n    main()` },
  javascript: { ext: "main.js", monacoLang: "javascript", code: `console.log("Hello from Node.js in AerolVM!");` },
  rust: { ext: "main.rs", monacoLang: "rust", code: `fn main() {\n    println!("Hello from Rust in AerolVM!");\n}` },
  go: { ext: "main.go", monacoLang: "go", code: `package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello from Go in AerolVM!")\n}` },
  cpp: { ext: "main.cpp", monacoLang: "cpp", code: `#include <iostream>\n\nint main() {\n    std::cout << "Hello from C++ in AerolVM!" << std::endl;\n    return 0;\n}` },
  java: { ext: "Main.java", monacoLang: "java", code: `public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello from Java in AerolVM!");\n    }\n}` },
  ruby: { ext: "main.rb", monacoLang: "ruby", code: `puts "Hello from Ruby in AerolVM!"` },
  php: { ext: "main.php", monacoLang: "php", code: `<?php\n\necho "Hello from PHP in AerolVM!\\n";` },
  bash: { ext: "main.sh", monacoLang: "shell", code: `#!/bin/bash\n\necho "Hello from Bash in AerolVM!"` },
  perl: { ext: "main.pl", monacoLang: "perl", code: `#!/usr/bin/perl\n\nprint "Hello from Perl in AerolVM!\\n";` }
};

document.addEventListener('DOMContentLoaded', () => {
  const languageSelect = document.getElementById('languageSelect');
  const fileNameDisplay = document.getElementById('fileNameDisplay');
  const runBtn = document.getElementById('runBtn');
  const terminalOutput = document.getElementById('terminalOutput');
  const statusIndicator = document.getElementById('statusIndicator');
  
  let editor = null;

  // Initialize Monaco Editor
  require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' }});
  require(['vs/editor/editor.main'], function() {
    editor = monaco.editor.create(document.getElementById('monaco-container'), {
      value: BOILERPLATES.python.code,
      language: BOILERPLATES.python.monacoLang,
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: 'JetBrains Mono, monospace',
      padding: { top: 16 }
    });
  });

  // Handle Language Change
  languageSelect.addEventListener('change', (e) => {
    const lang = e.target.value;
    const config = BOILERPLATES[lang];
    
    fileNameDisplay.textContent = config.ext;
    
    if (editor) {
      monaco.editor.setModelLanguage(editor.getModel(), config.monacoLang);
      editor.setValue(config.code);
    }
  });

  function setStatus(status, text) {
    statusIndicator.className = `status ${status}`;
    statusIndicator.textContent = text;
  }

  // Handle Run
  runBtn.addEventListener('click', async () => {
    if (!editor) return;
    
    const code = editor.getValue();
    const language = languageSelect.value;
    
    if (!code.trim()) return;

    // UI Updates
    runBtn.disabled = true;
    runBtn.innerHTML = '⚙️ Running...';
    terminalOutput.innerHTML = '<div class="output-line" style="color: var(--text-muted);">Provisioning sandbox and executing...</div>';
    setStatus('running', 'Running');

    try {
      const response = await fetch('/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language })
      });

      const data = await response.json();
      terminalOutput.innerHTML = ''; // clear

      if (!response.ok) {
        throw new Error(data.error || 'Unknown server error');
      }

      if (data.stdout) {
        const outDiv = document.createElement('div');
        outDiv.className = 'output-line';
        outDiv.textContent = data.stdout;
        terminalOutput.appendChild(outDiv);
      }

      if (data.stderr) {
        const errDiv = document.createElement('div');
        errDiv.className = 'output-line error-line';
        errDiv.textContent = data.stderr;
        terminalOutput.appendChild(errDiv);
      }

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
