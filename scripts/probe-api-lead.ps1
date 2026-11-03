# Lead 独立探测：HF / ModelScope 关键 API 行为（结果写入 docs/api-probe-lead.md）
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Show-Headers($headers, $names) {
    foreach ($n in $names) {
        $v = $headers[$n]
        if ($v) { Write-Host ("  {0}: {1}" -f $n, ($v -join ' | ')) }
    }
}

Write-Host "================ HF SEARCH ================"
try {
    $r = Invoke-WebRequest -Uri 'https://huggingface.co/api/models?search=Qwen&limit=3&sort=downloads&direction=-1' -UseBasicParsing -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode)"
    Show-Headers $r.Headers @('Link','X-Total-Count','x-error-code')
    $j = $r.Content | ConvertFrom-Json
    Write-Host "COUNT: $($j.Count)"
    $j | ForEach-Object { Write-Host ("  id={0} downloads={1} likes={2} gated={3} pipeline={4} lastModified={5}" -f $_.id, $_.downloads, $_.likes, $_.gated, $_.pipeline_tag, $_.lastModified) }
    Write-Host "FIELDS: $(($j[0].PSObject.Properties.Name) -join ', ')"
} catch { Write-Host "ERROR: $($_.Exception.Message)" }

Write-Host "================ HF TREE (small repo) ================"
try {
    $r = Invoke-WebRequest -Uri 'https://huggingface.co/api/models/Qwen/Qwen2.5-0.5B-Instruct/tree/main?recursive=true' -UseBasicParsing -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode)"
    Show-Headers $r.Headers @('Link','x-error-code')
    $j = $r.Content | ConvertFrom-Json
    Write-Host "COUNT: $($j.Count)"
    $j | Select-Object -First 5 | ForEach-Object { Write-Host ("  path={0} type={1} size={2} lfs={3}" -f $_.path, $_.type, $_.size, ($(if ($_.lfs) { $_.lfs.size } else { 'null' }))) }
    Write-Host "ENTRY FIELDS: $(($j[0].PSObject.Properties.Name) -join ', ')"
} catch { Write-Host "ERROR: $($_.Exception.Message)" }

Write-Host "================ HF TREE (big repo, pagination) ================"
try {
    $r = Invoke-WebRequest -Uri 'https://huggingface.co/api/models/Qwen/Qwen2.5-7B-Instruct/tree/main?recursive=true' -UseBasicParsing -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode) COUNT(on page): $((($r.Content | ConvertFrom-Json).Count))"
    Show-Headers $r.Headers @('Link')
} catch { Write-Host "ERROR: $($_.Exception.Message)" }

Write-Host "================ HF RESOLVE RANGE ================"
try {
    $r = Invoke-WebRequest -Uri 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/resolve/main/config.json' -Headers @{ Range = 'bytes=0-99' } -UseBasicParsing -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode) LEN: $($r.RawContentLength)"
    Show-Headers $r.Headers @('Content-Range','Content-Length','Accept-Ranges','ETag','Last-Modified','Location','X-Error-Code')
} catch { Write-Host "ERROR: $($_.Exception.Message)" }

Write-Host "================ HF GATED TREE (no token) ================"
try {
    $r = Invoke-WebRequest -Uri 'https://huggingface.co/api/models/meta-llama/Llama-3.1-8B-Instruct/tree/main?recursive=true' -UseBasicParsing -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode)"
    Show-Headers $r.Headers @('x-error-code')
    Write-Host "BODY(first 200): $($r.Content.Substring(0, [Math]::Min(200, $r.Content.Length)))"
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        Write-Host "  STATUS: $([int]$_.Exception.Response.StatusCode)"
        foreach ($h in @('x-error-code','x-error-message')) { $v = $_.Exception.Response.Headers[$h]; if ($v) { Write-Host "  ${h}: $v" } }
    }
}

Write-Host "================ MS FILES ================"
try {
    $r = Invoke-WebRequest -Uri 'https://www.modelscope.cn/api/v1/models/Qwen/Qwen2.5-0.5B-Instruct/repo/files?Recursive=true' -UseBasicParsing -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode)"
    $j = $r.Content | ConvertFrom-Json
    Write-Host "Success=$($j.Success) Code=$($j.Code) Message=$($j.Message)"
    $files = $j.Data.Files
    Write-Host "COUNT: $($files.Count)"
    $files | Select-Object -First 6 | ForEach-Object { Write-Host ("  Name={0} Path={1} Size={2} Type={3} Sha256={4} Revision={5}" -f $_.Name, $_.Path, $_.Size, $_.Type, ($(if ($_.Sha256) { $_.Sha256.Substring(0,8) } else { 'null' })), $_.Revision) }
    Write-Host "FILE FIELDS: $(($files[0].PSObject.Properties.Name) -join ', ')"
    Write-Host "DATA FIELDS: $(($j.Data.PSObject.Properties.Name) -join ', ')"
} catch { Write-Host "ERROR: $($_.Exception.Message)" }

Write-Host "================ MS SEARCH candidates ================"
try {
    $body = @{ PageSize = 3; PageNumber = 1; SortBy = 'Default'; Target = ''; SingleCriterion = @(); Name = 'Qwen' } | ConvertTo-Json -Depth 6
    $r = Invoke-WebRequest -Uri 'https://www.modelscope.cn/api/v1/dolphin/models' -Method Post -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 30
    Write-Host "POST /api/v1/dolphin/models STATUS: $($r.StatusCode)"
    $j = $r.Content | ConvertFrom-Json
    Write-Host "Success=$($j.Success) Code=$($j.Code) Message=$($j.Message)"
    Write-Host "DATA FIELDS: $(($j.Data.PSObject.Properties.Name) -join ', ')"
    Write-Host "BODY(first 500): $($r.Content.Substring(0, [Math]::Min(500, $r.Content.Length)))"
} catch { Write-Host "POST dolphin ERROR: $($_.Exception.Message)" }

foreach ($u in @(
    'https://www.modelscope.cn/api/v1/models?PageSize=3&PageNumber=1&Name=Qwen',
    'https://www.modelscope.cn/api/v1/dolphin/models?PageSize=3&PageNumber=1&Name=Qwen',
    'https://www.modelscope.cn/api/v1/models?PageSize=3&PageNumber=1'
)) {
    try {
        $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 20
        Write-Host "GET $u -> STATUS: $($r.StatusCode) BODY(first 300): $($r.Content.Substring(0, [Math]::Min(300, $r.Content.Length)))"
    } catch { Write-Host "GET $u -> ERROR: $($_.Exception.Message)" }
}

Write-Host "================ MS RESOLVE RANGE ================"
try {
    $r = Invoke-WebRequest -Uri 'https://www.modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct/resolve/master/config.json' -Headers @{ Range = 'bytes=0-99' } -UseBasicParsing -TimeoutSec 30
    Write-Host "STATUS: $($r.StatusCode) LEN: $($r.RawContentLength)"
    Show-Headers $r.Headers @('Content-Range','Content-Length','Accept-Ranges','ETag','Last-Modified','Location')
} catch { Write-Host "ERROR: $($_.Exception.Message)" }

Write-Host "================ HF MIRROR ================"
try {
    $r = Invoke-WebRequest -Uri 'https://hf-mirror.com/api/models?search=Qwen&limit=2' -UseBasicParsing -TimeoutSec 20
    Write-Host "hf-mirror API STATUS: $($r.StatusCode) BODY(first 200): $($r.Content.Substring(0, [Math]::Min(200, $r.Content.Length)))"
} catch { Write-Host "hf-mirror API ERROR: $($_.Exception.Message)" }
try {
    $r = Invoke-WebRequest -Uri 'https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct/resolve/main/config.json' -Headers @{ Range = 'bytes=0-99' } -UseBasicParsing -TimeoutSec 30
    Write-Host "hf-mirror resolve STATUS: $($r.StatusCode) LEN: $($r.RawContentLength)"
    Show-Headers $r.Headers @('Content-Range','Content-Length','Location')
} catch { Write-Host "hf-mirror resolve ERROR: $($_.Exception.Message)" }
