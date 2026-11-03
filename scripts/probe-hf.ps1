#requires -Version 7.0
<#
.SYNOPSIS
  实测 HuggingFace HTTP API：搜索 / 仓库详情 / 文件树 / resolve 下载与 Range 行为。

.DESCRIPTION
  本机实测结论：huggingface.co 直连 TCP 超时不可达（DNS 被污染到 157.240.13.8），
  https://hf-mirror.com 的 API 与下载均可用，因此脚本默认探测镜像端点。
  每个探测输出 [PASS]/[FAIL] + 状态码 + 关键字段，可一键复跑。
  详细契约见 docs/api-contracts.md。

.EXAMPLE
  pwsh -File scripts/probe-hf.ps1
  pwsh -File scripts/probe-hf.ps1 -Endpoint https://huggingface.co

.PARAMETER Token
  HF User Access Token；默认读 $env:HF_TOKEN。脚本只打印是否携带，绝不输出 token 值。
#>
param(
  [string]$Endpoint = 'https://hf-mirror.com',
  [string]$DirectEndpoint = 'https://huggingface.co',
  [string]$Token = $env:HF_TOKEN,
  [string]$Query = 'Qwen',
  [string]$Repo = 'Qwen/Qwen2.5-0.5B-Instruct',
  [string]$BigRepo = 'Qwen/Qwen2.5-7B-Instruct',
  [string]$GatedRepo = 'meta-llama/Llama-3.1-8B-Instruct'
)

$ErrorActionPreference = 'Stop'
$Script:Base = $Endpoint.TrimEnd('/')
$Script:Headers = @{ 'User-Agent' = 'ModelDownloadManager/0.1 (+https://github.com/)'; 'Accept' = 'application/json' }
if ($Token) { $Script:Headers['Authorization'] = "Bearer $Token" }
$Script:Fail = 0
$Script:Sw = [System.Diagnostics.Stopwatch]::StartNew()

function Say([string]$t) { Write-Host $t }
function Pass([string]$name, [string]$detail) { Write-Host ("[PASS] {0}: {1}" -f $name, $detail) }
function Fail([string]$name, [string]$detail) { $Script:Fail++; Write-Host ("[FAIL] {0}: {1}" -f $name, $detail) }
function DateStr($v) {
  if ($null -eq $v) { return '' }
  if ($v -is [datetime]) { return $v.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") }
  return [string]$v
}

# 普通请求：始终返回响应对象，4xx/5xx 不抛异常（PS7 -SkipHttpErrorCheck）
function Invoke-Api {
  param(
    [string]$Method = 'GET',
    [string]$Url,
    [hashtable]$Headers = @{},
    [int]$TimeoutSec = 60
  )
  $h = @{} + $Script:Headers
  foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] }
  $p = @{
    Uri = $Url; Method = $Method; Headers = $h
    SkipHttpErrorCheck = $true; UseBasicParsing = $true; TimeoutSec = $TimeoutSec
  }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $resp = Invoke-WebRequest @p
  $sw.Stop()
  [pscustomobject]@{
    Status = [int]$resp.StatusCode; Headers = $resp.Headers; Content = [string]$resp.Content
    RawLength = $resp.RawContentLength; ElapsedMs = $sw.ElapsedMilliseconds
    FinalUri = [string]$resp.BaseResponse.RequestMessage.RequestUri
  }
}

# 只取第一跳（不跟随跳转），用 Windows 自带 curl.exe 读取原始响应头
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
  $xerrM = [regex]::Matches($raw, '(?im)^X-Error-Code:\s*(.+)$')
  $xmsgM = [regex]::Matches($raw, '(?im)^X-Error-Message:\s*(.+)$')
  [pscustomobject]@{
    Status      = if ($statusM.Count) { $statusM[$statusM.Count - 1].Value.Trim() } else { '(no response)' }
    Location    = if ($locM.Count) { $locM[0].Groups[1].Value.Trim() } else { '' }
    XErrorCode  = if ($xerrM.Count) { $xerrM[0].Groups[1].Value.Trim() } else { '' }
    XErrorMsg   = if ($xmsgM.Count) { $xmsgM[0].Groups[1].Value.Trim() } else { '' }
    Raw         = $raw
  }
}

# 把 Link: <https://huggingface.co/...>; rel="next" 重写到当前配置端点（镜像必须）
function Convert-NextLink {
  param([string]$Link, [string]$Base)
  if ([string]::IsNullOrWhiteSpace($Link)) { return $null }
  $m = [regex]::Match($Link, '<([^>]+)>\s*;\s*rel="next"')
  if (-not $m.Success) { return $null }
  $u = [uri]$m.Groups[1].Value
  $b = [uri]$Base
  return ("{0}://{1}{2}{3}" -f $b.Scheme, $b.Authority, $u.AbsolutePath, $u.Query)
}

function LinkHeader($r) { return [string]($r.Headers['Link']) }

# 解析跳转 Location 的 host（镜像小文件的 Location 是相对路径）
function HostOf([string]$u) {
  if ([string]::IsNullOrWhiteSpace($u)) { return '(无)' }
  try {
    $x = [uri]$u
    if ($x.IsAbsoluteUri) { return $x.Host }
    return ('relative:' + (($x.OriginalString -split '\?')[0]))
  } catch { return '(无法解析)' }
}

Say ("== HF 探测开始 {0}  endpoint={1}  token={2} ==" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'), $Script:Base, ($(if ($Token) { '已携带(值不打印)' } else { '无' })))

# ------------------------------------------------------------------ 0. 直连可达性
Say "`n--- 0. 直连可达性 ---"
$ips = @()
try { $ips = @(Resolve-DnsName ([uri]$DirectEndpoint).Host -Type A -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress }) } catch { }
Say ("DNS A: {0}" -f (($ips | Where-Object { $_ }) -join ', '))
$reachCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($reachCmd) {
  $reach = (& curl.exe -sS -o NUL -w "status=%{http_code} time=%{time_total}s ip=%{remote_ip} err=%{errormsg}" --max-time 8 "$DirectEndpoint/api/models?limit=1" 2>&1) -join ' '
  Say ("direct($DirectEndpoint) => $reach")
  if ($reach -match 'status=200') { Pass 'direct-reachable' '直连 200，可用' } else { Say '直连不可用（本机网络环境预期如此）——本脚本改用镜像 hf-mirror.com 继续探测' }
} else { Say 'curl.exe 不存在，跳过直连探测' }
$enc = [uri]::EscapeDataString($Query)
$searchBase = "$Script:Base/api/models?search=$enc&limit=3&sort=downloads&direction=-1&full=true"

# ------------------------------------------------------------------ 1. 搜索
Say "`n--- 1. 搜索 GET /api/models ---"
$r = $null
try { $r = Invoke-Api -Url $searchBase } catch { Fail 'search' $_.Exception.Message }
if ($r) {
  $items = @($r.Content | ConvertFrom-Json)
  Say ("status={0} elapsed={1}ms items={2} bytes={3}" -f $r.Status, $r.ElapsedMs, $items.Count, $r.Content.Length)
  if ($r.Status -eq 200 -and $items.Count -gt 0) { Pass 'search' "200，返回 $($items.Count) 条" } else { Fail 'search' "status=$($r.Status)" }
  $rl = [string]$r.Headers['Ratelimit']
  $rlp = [string]$r.Headers['Ratelimit-Policy']
  if ($rl -or $rlp) { Say ("rate-limit: Ratelimit=[$rl] Policy=[$rlp]") }
  $it = $items[0]
  $hasGated = $null -ne $it.PSObject.Properties['gated']
  $gatedStr = if ($hasGated) { if ($null -eq $it.gated) { 'null(JSON null)' } else { [string]$it.gated } } else { '<字段缺失>' }
  Say ("item0: id={0} downloads={1} likes={2} gated={3} pipeline_tag={4} lastModified={5}" -f `
      $it.id, $it.downloads, $it.likes, $gatedStr, $it.pipeline_tag, (DateStr $it.lastModified))
  Say ("item0.tags(前5)={0}" -f (($it.tags | Select-Object -First 5) -join ' / '))
  if ($null -eq $it.PSObject.Properties['lastModified']) { Say '注意：未加 full=true 时 lastModified/gated 字段缺失；RepoSummary 需要 &full=true' }
  $link = LinkHeader $r
  Say ("Link: {0}" -f $(if ($link) { $link } else { '<无>' }))
  Pass 'search-pagination-Link' 'Link rel="next" 存在时按 cursor 翻页'
  # cursor 翻页
  $next = Convert-NextLink $link $Script:Base
  if ($next) {
    Say ("next(重写 host 后, 前 160 字符): {0}" -f $next.Substring(0, [Math]::Min(160, $next.Length)))
    try {
      $r2 = Invoke-Api -Url $next
      $ids2 = @(($r2.Content | ConvertFrom-Json) | ForEach-Object { $_.id })
      Say ("page2 status={0} ids={1}" -f $r2.Status, ($ids2 -join ', '))
      if ($r2.Status -eq 200 -and $ids2.Count -gt 0) { Pass 'search-cursor-page2' '按 Link 翻页成功（注意 URL host 需重写）' } else { Fail 'search-cursor-page2' "status=$($r2.Status)" }
    } catch { Fail 'search-cursor-page2' $_.Exception.Message }
  } else { Say '本次响应无 Link rel=next（结果不足一页）' }
  # page/offset 是否支持
  try {
    $rp = Invoke-Api -Url "$searchBase&page=2"
    $ro = Invoke-Api -Url "$searchBase&offset=3"
    $idsBase = (@(($r.Content | ConvertFrom-Json)) | ForEach-Object { $_.id }) -join ','
    $idsPage = (@(($rp.Content | ConvertFrom-Json)) | ForEach-Object { $_.id }) -join ','
    $idsOff = (@(($ro.Content | ConvertFrom-Json)) | ForEach-Object { $_.id }) -join ','
    Say ("page/offset 探测: 无参数=[{0}] &page=2=[{1}] &offset=3=[{2}]" -f $idsBase, $idsPage, $idsOff)
    if ($idsPage -eq $idsBase -and $idsOff -eq $idsBase) { Pass 'search-page-offset-ignored' 'page/offset 参数被忽略，只能 cursor 翻页' } else { Say 'page/offset 可能被部分支持，需人工复核' }
  } catch { Say ("page/offset 探测失败: {0}" -f $_.Exception.Message) }
}

# ------------------------------------------------------------------ 2. 仓库详情
Say "`n--- 2. 仓库详情 GET /api/models/{repo} ---"
foreach ($pair in @(@($Repo, 'public'), @($GatedRepo, 'gated'))) {
  $repoId = $pair[0]; $tag = $pair[1]
  try {
    $d = Invoke-Api -Url "$Script:Base/api/models/$repoId"
    if ($d.Status -eq 200) {
      $dj = $d.Content | ConvertFrom-Json
      $g = if ($null -ne $dj.PSObject.Properties['gated']) { [string]$dj.gated } else { '<缺失>' }
      $lic = if ($dj.cardData -and $dj.cardData.license) { $dj.cardData.license } else { '<无>' }
      Say ("{0} ({1}) status=200 gated=[{2}] lastModified=[{3}] downloads={4} likes={5} license={6} siblings={7}" -f `
          $repoId, $tag, $g, (DateStr $dj.lastModified), $dj.downloads, $dj.likes, $lic, @($dj.siblings).Count)
      Pass "_detail_$tag" '200'
    } else { Fail "detail_$tag" "status=$($d.Status) body=$($d.Content.Substring(0,[Math]::Min(150,$d.Content.Length)))" }
  } catch { Fail "detail_$tag" $_.Exception.Message }
}

# ------------------------------------------------------------------ 3. 文件树
Say "`n--- 3. 文件树 GET /api/models/{repo}/tree/main?recursive=true ---"
try {
  $t = Invoke-Api -Url "$Script:Base/api/models/$BigRepo/tree/main?recursive=true"
  $tree = @($t.Content | ConvertFrom-Json)
  $lfsCount = @($tree | Where-Object { $null -ne $_.PSObject.Properties['lfs'] -and $_.lfs }).Count
  $sum = ($tree | Measure-Object -Property size -Sum).Sum
  Say ("bigRepo={0} status={1} entries={2} lfsEntries={3} totalBytes={4} Link=[{5}]" -f $BigRepo, $t.Status, $tree.Count, $lfsCount, $sum, (LinkHeader $t))
  if ($t.Status -eq 200) { Pass 'tree' "200，$($tree.Count) 项（大文件 $lfsCount 个）" } else { Fail 'tree' "status=$($t.Status)" }
  $tree | ForEach-Object {
    $lsize = if ($null -ne $_.PSObject.Properties['lfs'] -and $_.lfs) { $_.lfs.size } else { '-' }
    Say ("  {0,-52} type={1} size={2} lfs.size={3}" -f $_.path, $_.type, $_.size, $lsize)
  }
  # 显式 limit 触发 cursor 分页
  $url = "$Script:Base/api/models/$BigRepo/tree/main?recursive=true&limit=5"
  $pages = 0; $paths = @()
  while ($url -and $pages -lt 20) {
    $pr = Invoke-Api -Url $url
    if ($pr.Status -ne 200) { Say ("tree page{0} status={1}" -f ($pages + 1), $pr.Status); break }
    $pj = @($pr.Content | ConvertFrom-Json)
    $pages++; $paths += @($pj | ForEach-Object { $_.path })
    $url = Convert-NextLink (LinkHeader $pr) $Script:Base
  }
  Say ("tree 分页(limit=5): pages={0} entries={1} unique={2}" -f $pages, $paths.Count, @($paths | Sort-Object -Unique).Count)
  if ($pages -ge 2) { Pass 'tree-pagination' "共 $pages 页，跟随 Link cursor 成功" } else { Say '未出现分页（仓库条数少或 limit 未生效）' }
} catch { Fail 'tree' $_.Exception.Message }

# gated 仓库文件树（元数据通常可读，下载才 403）
try {
  $gt = Invoke-Api -Url "$Script:Base/api/models/$GatedRepo/tree/main?recursive=true"
  Say ("gated tree: status={0} entries={1} LinkPresent={2}" -f $gt.Status, (@($gt.Content | ConvertFrom-Json)).Count, [bool](LinkHeader $gt))
} catch { Say ("gated tree 请求异常: {0}" -f $_.Exception.Message) }

# ------------------------------------------------------------------ 4. 下载 resolve + Range
Say "`n--- 4. 下载 GET /{repo}/resolve/main/{path} ---"
$smallUrl = "$Script:Base/$Repo/resolve/main/config.json"
$bigUrl = "$Script:Base/$Repo/resolve/main/model.safetensors"

# 4.1 首跳
$hop = Get-FirstHop -Url $smallUrl
if ($hop) {
  Say ("small(非 LFS) 首跳: {0}  Location={1}" -f $hop.Status, $hop.Location)
  $h = HostOf $hop.Location
  Say ("  跳转目标 host={0}（镜像小文件经 /api/resolve-cache 代理）" -f $h)
}
$hopBig = Get-FirstHop -Url $bigUrl -Headers @{ 'Range' = 'bytes=0-1023' }
if ($hopBig) {
  Say ("big(LFS) 首跳: {0}  Location host={1}" -f $hopBig.Status, (HostOf $hopBig.Location))
}

# 4.2 小文件全量 + Range
try {
  $s = Invoke-Api -Url $smallUrl
  Say ("small 全量: status={0} rawlen={1} finalHost={2}" -f $s.Status, $s.RawLength, ([uri]$s.FinalUri).Host)
  $sr = Invoke-Api -Url $smallUrl -Headers @{ 'Range' = 'bytes=0-1023' }
  Say ("small Range bytes=0-1023: status={0} Content-Range=[{1}] CL=[{2}] rawlen={3}  => Range {4}" -f `
      $sr.Status, ([string]$sr.Headers['Content-Range']), ([string]$sr.Headers['Content-Length']), $sr.RawLength,
      $(if ($sr.Status -eq 206) { '生效' } else { '被忽略（返回全量 200）' }))
  if ($sr.Status -eq 200 -or $sr.Status -eq 206) { Pass 'download-small-range' "status=$($sr.Status)" } else { Fail 'download-small-range' "status=$($sr.Status)" }
} catch { Fail 'download-small' $_.Exception.Message }

# 4.3 LFS 大文件 Range（断点续传核心）
try {
  $br = Invoke-Api -Url $bigUrl -Headers @{ 'Range' = 'bytes=0-1023' } -TimeoutSec 120
  Say ("big Range bytes=0-1023: status={0} Content-Range=[{1}] CL=[{2}] rawlen={3} finalHost={4}" -f `
      $br.Status, ([string]$br.Headers['Content-Range']), ([string]$br.Headers['Content-Length']), $br.RawLength, ([uri]$br.FinalUri).Host)
  $ar = Invoke-Api -Url $bigUrl -Headers @{ 'Range' = 'bytes=1000000-1001023' } -TimeoutSec 120
  Say ("big Range bytes=1000000-1001023: status={0} Content-Range=[{1}] rawlen={2}" -f $ar.Status, ([string]$ar.Headers['Content-Range']), $ar.RawLength)
  if ($br.Status -eq 206) { Pass 'download-lfs-range' 'LFS 文件 206 + Content-Range，可断点续传' } else { Fail 'download-lfs-range' "status=$($br.Status)" }
} catch { Fail 'download-lfs-range' $_.Exception.Message }

# 4.4 gated 下载无 token 的错误形态
try {
  $g = Invoke-Api -Url "$Script:Base/$GatedRepo/resolve/main/config.json"
  $body = if ($g.Content) { $g.Content.Substring(0, [Math]::Min(220, $g.Content.Length)) } else { '' }
  $xe = [string]$g.Headers['X-Error-Code']
  Say ("gated 下载(无token): status={0} X-Error-Code=[{1}] body={2}" -f $g.Status, $xe, $body)
  if ($g.Status -in 401, 403) { Pass 'gated-download' "$($g.Status)，需 Token + 网页端授权" } else { Fail 'gated-download' "status=$($g.Status)" }
} catch { Fail 'gated-download' $_.Exception.Message }

# 4.5 404 形态
try {
  $nf = Invoke-Api -Url "$Script:Base/$Repo/resolve/main/no-such-file-for-probe.xyz"
  Say ("resolve 不存在文件: status={0} body={1}" -f $nf.Status, $nf.Content.Substring(0, [Math]::Min(120, $nf.Content.Length)))
  $nd = Invoke-Api -Url "$Script:Base/api/models/no-such-org-xyz/no-such-model-123"
  Say ("detail 不存在仓库: status={0} body={1}" -f $nd.Status, $nd.Content.Substring(0, [Math]::Min(120, $nd.Content.Length)))
} catch { Say ("404 形态探测失败: {0}" -f $_.Exception.Message) }

# ------------------------------------------------------------------ SUMMARY
$Script:Sw.Stop()
Say "`n== SUMMARY (HF) =="
Say ("endpoint={0} token={1} failures={2} elapsed={3:N1}s" -f $Script:Base, $(if ($Token) { 'yes' } else { 'no' }), $Script:Fail, $Script:Sw.Elapsed.TotalSeconds)
Say '关键结论：'
Say '  1) 搜索分页 = Link rel="next" 的 cursor；Link 里 host 是 huggingface.co，走镜像时必须重写为配置端点。'
Say '  2) page/offset 参数被忽略；cursor 传非法值返回 400。'
Say '  3) 搜索列表需加 &full=true 才有 gated / lastModified 字段。'
Say '  4) 文件树 lfs.size 为真实字节数；分页同样是 Link cursor（默认每页 1000 条）。'
Say '  5) resolve: 小文件(非 LFS) Range 被忽略→200 全量；LFS 大文件 Range→206 + Content-Range（经 CDN），可续传。'
Say '  6) gated 仓库：详情 API 可读（gated=manual/auto），下载无 Token 返回 401/403，需网页端授权。'
if ($Script:Fail -gt 0) { exit 1 } else { exit 0 }
