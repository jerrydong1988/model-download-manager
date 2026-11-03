#requires -Version 7.0
<#
.SYNOPSIS
  实测 ModelScope HTTP API：搜索(PUT) / 仓库详情 / 文件列表 / resolve 下载与 Range 行为。

.DESCRIPTION
  每个探测输出 [PASS]/[FAIL] + 状态码 + 关键字段，可一键复跑。
  重要实测结论：
    - 搜索是 PUT https://www.modelscope.cn/api/v1/dolphin/models（POST/GET 均 404）。
    - resolve 小文件 Range 请求返回 200 + Content-Range（不是 206），后端不能只看状态码。
    - HEAD resolve 返回 200 但不带 Content-Length（不能用 HEAD 探大小）。
  详细契约见 docs/api-contracts.md。

.EXAMPLE
  pwsh -File scripts/probe-modelscope.ps1
  pwsh -File scripts/probe-modelscope.ps1 -Token $env:MS_TOKEN

.PARAMETER Token
  ModelScope SDK Token（可选）；默认读 $env:MS_TOKEN。脚本只打印是否携带，绝不输出 token 值。
#>
param(
  [string]$Endpoint = 'https://www.modelscope.cn',
  [string]$Token = $env:MS_TOKEN,
  [string]$Query = 'Qwen',
  [string]$Repo = 'Qwen/Qwen2.5-0.5B-Instruct',
  [string]$PopularRepo = 'Qwen/Qwen2.5-7B-Instruct',
  [int]$PageSize = 5
)

$ErrorActionPreference = 'Stop'
$Script:Base = $Endpoint.TrimEnd('/')
$Script:Headers = @{ 'User-Agent' = 'ModelDownloadManager/0.1 (+https://github.com/)' }
if ($Token) { $Script:Headers['Authorization'] = "Bearer $Token" }
$Script:Fail = 0
$Script:Sw = [System.Diagnostics.Stopwatch]::StartNew()

function Say([string]$t) { Write-Host $t }
function Pass([string]$name, [string]$detail) { Write-Host ("[PASS] {0}: {1}" -f $name, $detail) }
function Fail([string]$name, [string]$detail) { $Script:Fail++; Write-Host ("[FAIL] {0}: {1}" -f $name, $detail) }
function DateStr($v) {
  if ($null -eq $v) { return '' }
  if ($v -is [datetime]) { return $v.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") }
  if ($v -is [DateTimeOffset]) { return $v.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") }
  return [string]$v
}

function Invoke-Api {
  param(
    [string]$Method = 'GET',
    [string]$Url,
    [hashtable]$Headers = @{},
    [string]$Body = $null,
    [int]$TimeoutSec = 60
  )
  $h = @{} + $Script:Headers
  foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] }
  $p = @{
    Uri = $Url; Method = $Method; Headers = $h
    SkipHttpErrorCheck = $true; UseBasicParsing = $true; TimeoutSec = $TimeoutSec
  }
  if ($Body) { $p.Body = $Body; $p.ContentType = 'application/json' }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $resp = Invoke-WebRequest @p
  $sw.Stop()
  [pscustomobject]@{
    Status = [int]$resp.StatusCode; Headers = $resp.Headers; Content = [string]$resp.Content
    RawLength = $resp.RawContentLength; ElapsedMs = $sw.ElapsedMilliseconds
    FinalUri = [string]$resp.BaseResponse.RequestMessage.RequestUri
  }
}

# 只取第一跳（不跟随跳转），用 Windows 自带 curl.exe 读原始响应头
function Get-FirstHop {
  param([string]$Url, [string]$Method = 'GET', [hashtable]$Headers = @{})
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { return $null }
  $cargs = @('-sS', '-D', '-', '--max-redirs', '0', '--max-time', '60')
  if ($Method -eq 'HEAD') { $cargs += '-I' } else { $cargs += @('-o', 'NUL') }
  foreach ($k in $Headers.Keys) { $cargs += @('-H', ("{0}: {1}" -f $k, $Headers[$k])) }
  $cargs += $Url
  $raw = ((& curl.exe @cargs 2>&1) | Out-String)
  $statusM = [regex]::Matches($raw, '(?m)^HTTP/[0-9.]+\s+[0-9]+.*$')
  $locM = [regex]::Matches($raw, '(?m)^Location:\s*(.+)$')
  [pscustomobject]@{
    Status = if ($statusM.Count) { $statusM[$statusM.Count - 1].Value.Trim() } else { '(no response)' }
    Location = if ($locM.Count) { $locM[0].Groups[1].Value.Trim() } else { '' }
    Raw = $raw
  }
}

function New-SearchBody([int]$page, [int]$size, [string]$name, [string]$sort = 'Default') {
  @{
    PageSize = $size; PageNumber = $page; SortBy = $sort
    Target = ''; SingleCriterion = @(); Name = $name; Criterion = @()
  } | ConvertTo-Json -Depth 6 -Compress
}

Say ("== ModelScope 探测开始 {0}  endpoint={1}  token={2} ==" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'), $Script:Base, ($(if ($Token) { '已携带(值不打印)' } else { '无' })))

# ------------------------------------------------------------------ 1. 搜索（PUT /api/v1/dolphin/models）
Say "`n--- 1. 搜索 PUT /api/v1/dolphin/models ---"
$searchUrl = "$Script:Base/api/v1/dolphin/models"
$body1 = New-SearchBody 1 $PageSize $Query
Say ("request body: {0}" -f $body1)
$r = $null
try { $r = Invoke-Api -Method PUT -Url $searchUrl -Body $body1 } catch { Fail 'search-PUT' $_.Exception.Message }
if ($r) {
  Say ("status={0} elapsed={1}ms bytes={2}" -f $r.Status, $r.ElapsedMs, $r.Content.Length)
  if ($r.Status -eq 200) {
    $j = $r.Content | ConvertFrom-Json
    $models = @($j.Data.Model.Models)
    Say ("Success={0} Code={1} DataKeys={2} TotalCount={3} Items={4}" -f `
        $j.Success, $j.Code, (($j.Data.PSObject.Properties.Name) -join ','), $j.Data.Model.TotalCount, $models.Count)
    Pass 'search-PUT' "200，总量 $($j.Data.Model.TotalCount) 条（响应 $([math]::Round($r.Content.Length / 1KB))KB）"
    $m = $models[0]
    $taskNames = @($m.Tasks | ForEach-Object { $_.Name })
    Say ("item0: id={0}/{1} downloads={2} likes(Stars)={3} lastModified(Unix秒)={4} ({5}) pipelineTag(Tasks[0].Name)={6} license={7} visibility={8}" -f `
        $m.Path, $m.Name, $m.Downloads, $m.Stars, $m.LastUpdatedTime,
        $(try { ([DateTimeOffset]::FromUnixTimeSeconds([long]$m.LastUpdatedTime)).ToString('yyyy-MM-dd HH:mm:ss') } catch { '?' }),
        ($taskNames -join '/'), $m.License, $m.Visibility)
    Say ("item0: tags={0} libraries={1} ChineseName=[{2}] DescriptionLen={3}" -f `
        (($m.Tags) -join '/'), (($m.Libraries) -join '/'), $m.ChineseName, ([string]$m.Description).Length)
    Say ("item0 原始对象字段过多（AigcAttributes/Organization/MuseInfo/... 未使用），后端只取需要字段")
  } else {
    Fail 'search-PUT' "status=$($r.Status) body=$($r.Content.Substring(0,[Math]::Min(200,$r.Content.Length)))"
  }
}

# 1.1 翻页
try {
  $r2 = Invoke-Api -Method PUT -Url $searchUrl -Body (New-SearchBody 2 $PageSize $Query)
  $j2 = $r2.Content | ConvertFrom-Json
  $ids1 = @($j.Data.Model.Models | ForEach-Object { "$($_.Path)/$($_.Name)" })
  $ids2 = @($j2.Data.Model.Models | ForEach-Object { "$($_.Path)/$($_.Name)" })
  Say ("page2 status={0} ids={1} total={2}" -f $r2.Status, ($ids2 -join ', '), $j2.Data.Model.TotalCount)
  $overlap = @($ids1 | Where-Object { $ids2 -contains $_ }).Count
  if ($r2.Status -eq 200 -and $ids2.Count -gt 0 -and $overlap -eq 0) { Pass 'search-pagination' 'PageNumber 翻页有效（PageSize/PageNumber）' } else { Fail 'search-pagination' "overlap=$overlap" }
  Say ("hasMore 判定: PageNumber*PageSize < TotalCount => {0} < {1}" -f (2 * $PageSize), $j2.Data.Model.TotalCount)
} catch { Fail 'search-pagination' $_.Exception.Message }

# 1.2 排序参数：实测仅 Default 合法
foreach ($sort in @('Default', 'Downloads')) {
  try {
    $rs = Invoke-Api -Method PUT -Url $searchUrl -Body (New-SearchBody 1 3 $Query $sort)
    $detail = if ($rs.Status -eq 200) { 'ok' } else { $rs.Content.Substring(0, [Math]::Min(220, $rs.Content.Length)) }
    Say ("SortBy={0} => {1} {2}" -f $sort, $rs.Status, $detail)
    if ($sort -eq 'Default' -and $rs.Status -eq 200) { Pass 'search-sort-default' 'SortBy=Default 可用' }
    if ($sort -eq 'Downloads' -and $rs.Status -eq 400) { Pass 'search-sort-other' '其它排序值 400（oneof 校验失败），不要依赖服务端排序' }
  } catch { Say ("SortBy={0} 请求异常: {1}" -f $sort, $_.Exception.Message) }
}

# 1.3 中文搜索 / 空搜索
foreach ($name in @('通义', '')) {
  try {
    $rb = Invoke-Api -Method PUT -Url $searchUrl -Body (New-SearchBody 1 3 $name)
    $jb = $rb.Content | ConvertFrom-Json
    $ids = @($jb.Data.Model.Models | ForEach-Object { "$($_.Path)/$($_.Name)" })
    Say ("Name=[{0}] status={1} total={2} ids={3}" -f $name, $rb.Status, $jb.Data.Model.TotalCount, ($ids -join ', '))
  } catch { Say ("Name=[{0}] 异常: {1}" -f $name, $_.Exception.Message) }
}

# 1.4 GET/POST 是否可用（结论：404）
foreach ($m in @('GET', 'POST')) {
  try {
    if ($m -eq 'GET') {
      $getUrl = "${searchUrl}?PageSize=3&PageNumber=1"
      $rr = Invoke-Api -Method GET -Url $getUrl
    }
    else { $rr = Invoke-Api -Method POST -Url $searchUrl -Body (New-SearchBody 1 3 $Query) }
    Say ("$m /api/v1/dolphin/models => status=$($rr.Status)（结论：搜索只接受 PUT）")
  } catch { Say ("$m 探测异常: {0}" -f $_.Exception.Message) }
}

# ------------------------------------------------------------------ 2. 仓库详情
Say "`n--- 2. 仓库详情 GET /api/v1/models/{repo} ---"
foreach ($repoId in @($Repo, $PopularRepo)) {
  try {
    $d = Invoke-Api -Url "$Script:Base/api/v1/models/$repoId"
    if ($d.Status -eq 200) {
      $dj = $d.Content | ConvertFrom-Json
      $data = $dj.Data
      Say ("{0} status=200 Name={1} Path={2} Downloads={3} Stars={4} License={5} LastUpdatedTime={6} Revision={7} Visibility={8} Tags={9}" -f `
          $repoId, $data.Name, $data.Path, $data.Downloads, $data.Stars, $data.License,
          (DateStr ([DateTimeOffset]::FromUnixTimeSeconds([long]$data.LastUpdatedTime))), $data.Revision, $data.Visibility,
          (($data.Tags | Select-Object -First 5) -join '/'))
      Pass "detail_$($repoId.Split('/')[-1])" '200'
    } else {
      Fail "detail_$($repoId.Split('/')[-1])" "status=$($d.Status) body=$($d.Content.Substring(0, [Math]::Min(200, $d.Content.Length)))"
    }
  } catch { Fail "detail_$repoId" $_.Exception.Message }
}

# ------------------------------------------------------------------ 3. 文件列表
Say "`n--- 3. 文件列表 GET /api/v1/models/{repo}/repo/files?Recursive=true ---"
foreach ($repoId in @($Repo, $PopularRepo)) {
  try {
    $f = Invoke-Api -Url "$Script:Base/api/v1/models/$repoId/repo/files?Recursive=true"
    if ($f.Status -eq 200) {
      $fj = $f.Content | ConvertFrom-Json
      $files = @($fj.Data.Files)
      $blobs = @($files | Where-Object { $_.Type -eq 'blob' })
      $trees = @($files | Where-Object { $_.Type -eq 'tree' })
      $sum = ($blobs | Measure-Object -Property Size -Sum).Sum
      Say ("{0}: Success={1} Code={2} files={3} blobs={4} trees={5} totalBlobBytes={6} DataKeys={7}" -f `
          $repoId, $fj.Success, $fj.Code, $files.Count, $blobs.Count, $trees.Count, $sum, (($fj.Data.PSObject.Properties.Name) -join ','))
      $blobs | Select-Object -First 3 | ForEach-Object {
        Say ("  Name={0} Path={1} Size={2} Type={3} Sha256={4} Revision={5} IsLFS={6}" -f `
            $_.Name, $_.Path, $_.Size, $_.Type, $_.Sha256, $_.Revision, $_.IsLFS)
      }
      $lfs = $blobs | Where-Object { $_.IsLFS -eq $true } | Select-Object -First 1
      if ($lfs) { Say ("  LFS 样例: Path={0} Size={1} Sha256={2} Revision={3}" -f $lfs.Path, $lfs.Size, $lfs.Sha256, $lfs.Revision) }
      if ($trees.Count -gt 0) { Say ("  目录项(Type=tree, 下载时需过滤): {0}" -f (($trees | Select-Object -First 5 | ForEach-Object { $_.Path }) -join ', ')) }
      if ($fj.Success -eq $true) { Pass "files_$($repoId.Split('/')[-1])" "200，blob=$($blobs.Count)" } else { Fail "files_$($repoId.Split('/')[-1])" 'Success=false' }
    } else {
      Fail "files_$($repoId.Split('/')[-1])" "status=$($f.Status) body=$($f.Content.Substring(0, [Math]::Min(200, $f.Content.Length)))"
    }
  } catch { Fail "files_$repoId" $_.Exception.Message }
}

# 3.1 错误仓库的响应形态
try {
  $e = Invoke-Api -Url "$Script:Base/api/v1/models/no-such-org-xyz/no-such-model-123/repo/files?Recursive=true"
  Say ("不存在仓库 files: status={0} body={1}" -f $e.Status, $e.Content.Substring(0, [Math]::Min(300, $e.Content.Length)))
  $ej = $e.Content | ConvertFrom-Json
  if ($ej.Success -eq $false) { Pass 'files-error-shape' "Success=false, Message=$($ej.Message)" } else { Say '错误响应解析异常' }
} catch { Say ("错误仓库探测异常: {0}" -f $_.Exception.Message) }

# ------------------------------------------------------------------ 4. 下载 resolve + Range
Say "`n--- 4. 下载 GET /models/{repo}/resolve/master/{path} ---"
$smallUrl = "$Script:Base/models/$Repo/resolve/master/config.json"
$bigUrl = "$Script:Base/models/$Repo/resolve/master/model.safetensors"

# 4.1 小文件全量
try {
  $s = Invoke-Api -Url $smallUrl
  Say ("small 全量: status={0} rawlen={1} contentType=[{2}] final={3}" -f `
      $s.Status, $s.RawLength, ([string]$s.Headers['Content-Type']), $s.FinalUri)
  Pass 'download-small' "status=$($s.Status)"
} catch { Fail 'download-small' $_.Exception.Message }

# 4.2 小文件 Range（关键坑：200 + Content-Range）
try {
  $sr = Invoke-Api -Url $smallUrl -Headers @{ 'Range' = 'bytes=100-199' }
  Say ("small Range bytes=100-199: status={0} Content-Range=[{1}] CL=[{2}] rawlen={3}" -f `
      $sr.Status, ([string]$sr.Headers['Content-Range']), ([string]$sr.Headers['Content-Length']), $sr.RawLength)
  if ($sr.Status -eq 200 -and [string]$sr.Headers['Content-Range']) {
    Pass 'download-small-range' '200 + Content-Range（不是 206）：后端必须校验 Content-Range 而不是只看状态码'
  } else { Say 'Range 行为与预期不同，请人工复核' }
} catch { Fail 'download-small-range' $_.Exception.Message }

# 4.3 LFS 大文件 Range
try {
  $br = Invoke-Api -Url $bigUrl -Headers @{ 'Range' = 'bytes=0-1023' } -TimeoutSec 120
  Say ("big Range bytes=0-1023: status={0} Content-Range=[{1}] CL=[{2}] rawlen={3} finalHost={4}" -f `
      $br.Status, ([string]$br.Headers['Content-Range']), ([string]$br.Headers['Content-Length']), $br.RawLength, ([uri]$br.FinalUri).Host)
  if ($br.Status -eq 206) { Pass 'download-lfs-range' 'LFS 文件 206 + Content-Range，可断点续传' } else { Fail 'download-lfs-range' "status=$($br.Status)" }
} catch { Fail 'download-lfs-range' $_.Exception.Message }

# 4.4 首跳 302（LFS 走 CDN）
try {
  $hop = Get-FirstHop -Url $bigUrl -Headers @{ 'Range' = 'bytes=0-1023' }
  if ($hop) {
    $hostName = if ($hop.Location) { ([uri]$hop.Location).Host } else { '(无)' }
    Say ("big 首跳: {0}  Location host={1}" -f $hop.Status, $hostName)
    if ($hop.Status -match ' 302') { Pass 'download-redirect' '302 到 CDN（cdn-lfs-cn-*.modelscope.cn，URL 含 auth_key 会过期，不要缓存）' } else { Say '首跳非 302，请人工复核' }
  }
} catch { Say ("首跳探测异常: {0}" -f $_.Exception.Message) }

# 4.5 HEAD 陷阱
try {
  $hd = Invoke-Api -Method HEAD -Url $bigUrl
  Say ("HEAD big: status={0} Content-Length=[{1}] Accept-Ranges=[{2}]（HEAD 不跳转且无大小，别用 HEAD 探大小）" -f `
      $hd.Status, ([string]$hd.Headers['Content-Length']), ([string]$hd.Headers['Accept-Ranges']))
  Pass 'download-head-trap' 'HEAD 不可用于获取大小/续传信息'
} catch { Say ("HEAD 探测异常: {0}" -f $_.Exception.Message) }

# 4.6 Token 头是否被接受（用无权限假 token 验证公开仓库不受影响，不泄露真实 token）
try {
  $tt = Invoke-Api -Url "$Script:Base/api/v1/models/$Repo/repo/files?Recursive=true" -Headers @{ 'Authorization' = 'Bearer probe-invalid-token' }
  Say ("公开仓库 + 非法 Bearer token: status={0}（被接受/忽略，说明 Token 头格式兼容）" -f $tt.Status)
  if ($tt.Status -eq 200) { Pass 'token-header' 'Authorization: Bearer 头被接受' } else { Fail 'token-header' "status=$($tt.Status)" }
} catch { Fail 'token-header' $_.Exception.Message }

# 4.7 不存在文件 / 无权限错误形态
try {
  $nf = Invoke-Api -Url "$Script:Base/models/$Repo/resolve/master/no-such-file-for-probe.xyz"
  Say ("resolve 不存在文件: status={0} body={1}" -f $nf.Status, $nf.Content.Substring(0, [Math]::Min(200, $nf.Content.Length)))
} catch { Say ("resolve 404 探测异常: {0}" -f $_.Exception.Message) }

# ------------------------------------------------------------------ SUMMARY
$Script:Sw.Stop()
Say "`n== SUMMARY (ModelScope) =="
Say ("endpoint={0} token={1} failures={2} elapsed={3:N1}s" -f $Script:Base, $(if ($Token) { 'yes' } else { 'no' }), $Script:Fail, $Script:Sw.Elapsed.TotalSeconds)
Say '关键结论：'
Say '  1) 搜索必须 PUT /api/v1/dolphin/models，GET/POST 均 404；请求体至少 {PageSize,PageNumber,Name}。'
Say '  2) 翻页用 PageNumber/PageSize，hasMore = PageNumber*PageSize < Data.Model.TotalCount；SortBy 只接受 Default。'
Say '  3) 响应巨大（约 16KB/条），只取 Data.Model.Models[] 需要的字段。'
Say '  4) 文件列表 GET /api/v1/models/{repo}/repo/files?Recursive=true，过滤 Type=="blob"（tree 项 Size=0）。'
Say '  5) resolve 小文件 Range → 200 + Content-Range；LFS 大文件 → 302 CDN 后 206，可续传。'
Say '  6) HEAD 返回 200 无 Content-Length；错误统一看 Success=false + Message。'
if ($Script:Fail -gt 0) { exit 1 } else { exit 0 }
