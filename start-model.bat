@echo off
rem ============================================================
rem  Starts the gufo model server (port 8080)
rem  Runs C:\AI\gufo-build\gufo.exe serve directly, but only if
rem  nothing is listening on 8080 yet.
rem ============================================================
setlocal
set "GUFO_EXE=C:\AI\gufo-build\gufo.exe"

netstat -ano | findstr /r /c:":8080  *[0-9].*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Model server already listening on 8080.
  exit /b 0
)

if not exist "%GUFO_EXE%" (
  echo ERROR: "%GUFO_EXE%" not found.
  exit /b 1
)

echo Starting the model server on port 8080 ...
start "gufo qwen3.8-flash-next-unsloth-q4-k-xl" /min cmd /c ""%GUFO_EXE%" serve --host 0.0.0.0 --port 8080 --sessions 1 --max-request-bytes 1073741824 llm --model "C:\AI\gufo-data\models\unsloth-UD-Q4_K_XL\Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf" --mmproj "C:\AI\gufo-data\models\mmproj-Qwen3.8-Flash-Next-BF16.gguf" --served-model-name qwen3.8-flash-next-unsloth-q4-k-xl --context 262144 --temperature 0.6 --top-p 0.95 --top-k 20 --min-p 0 --think on --preserve-thinking on --speculative mtp --mtp-model "C:\AI\gufo-data\models\mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf" --draft-tokens 7 --max-output-bytes 1073741824 --cache-ram-bytes 34769803776 --mtp-draft-vocab latin --mtp-policy survival --prompt-lookup"
