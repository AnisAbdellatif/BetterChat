# deploy-kit's YAML reader (lib/yaml.sh runs it): the block YAML Ruby's
# to_yaml writes, which is what `kamal config` prints, and the plain YAML
# people write in Kamal configs. Portable awk (mawk, gawk, BSD, busybox).
#
#   awk -v mode=get|keys|type -v path=a.b.c -f yaml.awk < file.yml
#
# Paths are keys joined with dots; a key matches with or without Ruby's
# symbol colon (":ssh_options:" is ssh_options). Modes:
#   get    a value: printed as is; a list of values: one per line; a map of
#          values: KEY=VALUE per line
#   keys   a map's keys, one per line
#   type   map, list, value or alias
# Exit status: 0 found, 1 not there, 3 not readable here (anything outside
# the subset: flow collections inside flow collections, a list or map of
# values that aren't all plain values, an alias, a multi-line value in a
# list or map). Never a guess: what it can't read, it refuses.
#
# Supported: block maps and lists (lists indented or not under their key),
# plain, 'single' and "double" quoted scalars, folded continuation lines,
# | and > block scalars, [a, b] and {a: b} on one line, comments, tags
# (!ruby/object:...) and anchors (&a), skipped; ERB on lines of its own
# (<% ... %>, over one line or several) and document markers, ignored. ERB
# within a value stays in it, as text.

function fail(msg) {
  printf "yaml: line %d: %s\n", NR, msg > "/dev/stderr"
  failed = 1
  exit 3
}

# A refusal once the whole file is read: nothing printed but the reason.
function refuse(msg) {
  printf "yaml: %s\n", msg > "/dev/stderr"
  exit 3
}

function ltrim(s) { sub(/^[ \t]+/, "", s); return s }
function rtrim(s) { sub(/[ \t]+$/, "", s); return s }
function trim(s) { return rtrim(ltrim(s)) }

# A line without its comment: "#" at the start or after a blank, outside
# quotes. Quotes count only where a scalar can start (after a blank, "[",
# "{" or ","): the "'" in `it's` is text.
function strip_comment(s,    i, c, q, prev, n) {
  q = ""
  prev = " "
  n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (q == "") {
      if ((c == "\"" || c == "'") && index(" \t[{,", prev) > 0) q = c
      else if (c == "#" && index(" \t", prev) > 0) return rtrim(substr(s, 1, i - 1))
    } else if (q == "'") {
      if (c == "'") {
        if (substr(s, i + 1, 1) == "'") i++
        else q = ""
      }
    } else {
      if (c == "\\") i++
      else if (c == "\"") q = ""
    }
    prev = c
  }
  return rtrim(s)
}

# The key of a "key: value" line (quoted or plain, Ruby symbols included),
# or "" when the line isn't one. Sets REST to what follows the colon.
function key_of(s,    q, i, n, k) {
  REST = ""
  q = substr(s, 1, 1)
  if (q == "\"" || q == "'") {
    n = length(s)
    for (i = 2; i <= n; i++) {
      if (substr(s, i, 1) == q) {
        if (q == "'" && substr(s, i + 1, 1) == "'") { i++; continue }
        if (q == "\"" && substr(s, i - 1, 1) == "\\") continue
        break
      }
    }
    if (i > n || substr(s, i + 1, 1) != ":") return ""
    if (i + 1 < n && substr(s, i + 2, 1) != " ") return ""
    REST = trim(substr(s, i + 2))
    return unquote(substr(s, 1, i))
  }
  if (q == "-" && (s == "-" || substr(s, 2, 1) == " ")) return ""
  if (q == "[" || q == "{") return ""
  # A symbol key (":name:") starts with its colon: look past it.
  i = (q == ":") ? 2 : 1
  n = length(s)
  for (; i <= n; i++) {
    if (substr(s, i, 1) == ":" && (i == n || substr(s, i + 1, 1) == " ")) break
  }
  if (i > n) return ""
  k = trim(substr(s, 1, i - 1))
  if (k == "") return ""
  REST = trim(substr(s, i + 1))
  return k
}

# A key as paths name it: without Ruby's symbol colon, unquoted.
function norm(k) {
  if (substr(k, 1, 1) == ":") k = substr(k, 2)
  return k
}

# A scalar's text: quotes removed and escapes read.
function unquote(s,    q, inner, out, i, n, c, d) {
  s = trim(s)
  q = substr(s, 1, 1)
  if (length(s) >= 2 && (q == "'" || q == "\"") && substr(s, length(s), 1) == q) {
    inner = substr(s, 2, length(s) - 2)
    if (q == "'") {
      gsub(/''/, "'", inner)
      return inner
    }
    out = ""
    n = length(inner)
    for (i = 1; i <= n; i++) {
      c = substr(inner, i, 1)
      if (c == "\\" && i < n) {
        i++
        d = substr(inner, i, 1)
        if (d == "n") c = "\n"
        else if (d == "t") c = "\t"
        else if (d == "0") c = ""
        else c = d
      }
      out = out c
    }
    return out
  }
  if (s == "~" || s == "null") return ""
  return s
}

# Tags (!ruby/object:...) and anchors (&name) before a value: skipped.
function strip_props(s) {
  while (s ~ /^[!&][^ ]*/) {
    sub(/^[!&][^ ]*[ ]*/, "", s)
  }
  return s
}

function add_child(parent, seg,    p, kids) {
  p = (parent == "") ? seg : parent SUBSEP seg
  if (!(p in T)) {
    # Worked out first: mawk creates KIDS[parent] as soon as it's assigned.
    if (parent in KIDS) kids = KIDS[parent] "\035" seg
    else kids = seg
    KIDS[parent] = kids
  }
  return p
}

# Stores a node's value (the rest of a line: scalar, flow collection,
# alias, or nothing yet).
function set_value(p, ind, v,    items, n, i, kv, k) {
  v = strip_props(v)
  if (v == "") {
    PENDING = p
    PENDING_IND = ind
    return
  }
  if (substr(v, 1, 1) == "*") {
    T[p] = "alias"
    return
  }
  if (v ~ /^[|>]/) {
    T[p] = "value"
    V[p] = ""
    BLOCKS[p] = 1
    BLOCK = p
    BLOCK_FOLD = (substr(v, 1, 1) == ">")
    BLOCK_IND = ind
    BLOCK_TEXT_IND = -1
    BLOCK_LINES = 0
    return
  }
  if (substr(v, 1, 1) == "[") {
    if (substr(v, length(v), 1) != "]") fail("a [list] across lines isn't read here")
    T[p] = "list"
    n = split_flow(substr(v, 2, length(v) - 2), items)
    for (i = 1; i <= n; i++) {
      if (items[i] ~ /^[\[{]/) fail("nested flow collections aren't read here")
      k = add_child(p, "#" i)
      T[k] = "value"
      V[k] = items[i]
    }
    return
  }
  if (substr(v, 1, 1) == "{") {
    if (substr(v, length(v), 1) != "}") fail("a {map} across lines isn't read here")
    T[p] = "map"
    n = split_flow(substr(v, 2, length(v) - 2), items)
    for (i = 1; i <= n; i++) {
      kv = key_of(items[i])
      if (kv == "") fail("not a key: value pair in {...}: " items[i])
      if (REST ~ /^[\[{]/) fail("nested flow collections aren't read here")
      k = add_child(p, norm(kv))
      T[k] = "value"
      V[k] = REST
    }
    return
  }
  T[p] = "value"
  V[p] = v
  OPEN = p
  OPEN_IND = ind
}

# Splits the inside of [ ] or { } on commas outside quotes.
function split_flow(s, items,    n, i, c, q, cur, len) {
  n = 0
  q = ""
  cur = ""
  len = length(s)
  for (i = 1; i <= len; i++) {
    c = substr(s, i, 1)
    if (q == "") {
      if ((c == "\"" || c == "'") && trim(cur) == "") q = c
      else if (c == ",") { if (trim(cur) != "") items[++n] = trim(cur); cur = ""; continue }
      else if (c == "[" || c == "{") fail("nested flow collections aren't read here")
    } else if (c == q) {
      if (q == "'" && substr(s, i + 1, 1) == "'") { cur = cur c; i++ }
      else if (!(q == "\"" && substr(cur, length(cur), 1) == "\\")) q = ""
    }
    cur = cur c
  }
  if (trim(cur) != "") items[++n] = trim(cur)
  return n
}

function push(ind, p, kind) {
  depth++
  SIND[depth] = ind
  SPATH[depth] = p
  SKIND[depth] = kind
  if (!(p in T)) T[p] = kind
}

function end_block(    ) {
  if (BLOCK == "") return
  # Trailing blank lines aren't part of the value we give back.
  sub(/\n+$/, "", V[BLOCK])
  BLOCK = ""
}

BEGIN {
  depth = 0
  PENDING = ""
  OPEN = ""
  BLOCK = ""
  T[""] = "map"
}

{
  line = $0
  sub(/\r$/, "", line)

  # Inside a | or > block: lines indented past its key, and blank lines.
  if (BLOCK != "") {
    if (line ~ /^[ \t]*$/) {
      if (BLOCK_LINES > 0) V[BLOCK] = V[BLOCK] "\n"
      next
    }
    match(line, /^ */)
    if (RLENGTH > BLOCK_IND) {
      if (BLOCK_TEXT_IND < 0) BLOCK_TEXT_IND = RLENGTH
      text = substr(line, BLOCK_TEXT_IND + 1)
      if (BLOCK_LINES > 0) {
        last = substr(V[BLOCK], length(V[BLOCK]), 1)
        if (!BLOCK_FOLD) V[BLOCK] = V[BLOCK] "\n"
        else if (last != "\n") V[BLOCK] = V[BLOCK] " "
      }
      V[BLOCK] = V[BLOCK] text
      BLOCK_LINES++
      next
    }
    end_block()
  }

  if (line ~ /^[ \t]*$/) next
  if (line == "---" || line == "...") next
  if (substr(line, 1, 4) == "--- ") line = substr(line, 5)
  # ERB on lines of its own (Kamal evaluates it before reading the YAML):
  # skipped, over several lines if it spans them.
  if (IN_ERB) {
    if (index(line, "%>") > 0) IN_ERB = 0
    next
  }
  if (line ~ /^[ \t]*<%/) {
    if (index(substr(line, index(line, "<%") + 2), "%>") == 0) IN_ERB = 1
    next
  }
  if (line ~ /^\t/) fail("a tab in the indentation")

  match(line, /^ */)
  ind = RLENGTH
  c = strip_comment(substr(line, ind + 1))
  if (c == "") next

  # A plain or quoted value continued on the next lines (Ruby folds long
  # ones at 80 columns): a line indented past its key.
  if (OPEN != "") {
    if (ind > OPEN_IND) {
      prev = V[OPEN]
      if (substr(prev, length(prev), 1) == "\\") V[OPEN] = substr(prev, 1, length(prev) - 1) c
      else V[OPEN] = prev " " c
      next
    }
    OPEN = ""
  }

  # A key waiting for its value: a list (items at its indent or deeper),
  # a map (keys deeper), or nothing (an empty value).
  if (PENDING != "") {
    if ((c == "-" || substr(c, 1, 2) == "- ") && ind >= PENDING_IND) push(ind, PENDING, "list")
    else if (ind > PENDING_IND) push(ind, PENDING, "map")
    else { T[PENDING] = "value"; V[PENDING] = "" }
    PENDING = ""
  }

  is_item = (c == "-" || substr(c, 1, 2) == "- ")
  while (depth > 0 && (SIND[depth] > ind || (SIND[depth] == ind && SKIND[depth] == "list" && !is_item))) depth--
  if (depth == 0) {
    if (is_item) push(ind, "", "list")
    else push(ind, "", "map")
    T[""] = SKIND[depth]
  }
  if (SIND[depth] != ind) fail("unexpected indentation")

  if (SKIND[depth] == "list") {
    if (!is_item) fail("expected a list item")
    parent = SPATH[depth]
    N[parent]++
    item = add_child(parent, "#" N[parent])
    rest = (c == "-") ? "" : substr(c, 3)
    extra = match(rest, /^ */) ? RLENGTH : 0
    rest = substr(rest, extra + 1)
    k = key_of(rest)
    if (k != "") {
      # "- key: value": a map whose keys sit where this key does.
      push(ind + 2 + extra, item, "map")
      set_value(add_child(item, norm(k)), ind + 2 + extra, REST)
    } else if (strip_props(rest) == "") {
      # "-" alone: what follows, indented past the dash, is the item.
      PENDING = item
      PENDING_IND = ind + 1
    } else {
      set_value(item, ind, rest)
    }
    next
  }

  k = key_of(c)
  if (k == "") fail("expected a key")
  set_value(add_child(SPATH[depth], norm(k)), ind, REST)
}

function out_value(p, what) {
  if (T[p] == "alias") refuse(path ": an alias (*...) where " what " was asked for")
  if (T[p] != "value") refuse(path ": not " what)
  return unquote_final(p)
}

function unquote_final(p) {
  return (p in BLOCKS) ? V[p] : unquote(V[p])
}

END {
  if (failed) exit 3
  end_block()
  if (PENDING != "") { T[PENDING] = "value"; V[PENDING] = "" }

  # The node asked for: segments matched as normalized keys.
  p = ""
  if (path != "" && path != ".") {
    n = split(path, segs, ".")
    for (i = 1; i <= n; i++) {
      q = (p == "") ? segs[i] : p SUBSEP segs[i]
      if (!(q in T)) exit 1
      p = q
    }
  }
  if (!(p in T)) exit 1

  if (mode == "type") { print T[p]; exit 0 }

  kids = (p in KIDS) ? KIDS[p] : ""
  m = (kids == "") ? 0 : split(kids, names, "\035")

  if (mode == "keys") {
    if (T[p] != "map") refuse(path ": not a map")
    for (i = 1; i <= m; i++) print names[i]
    exit 0
  }

  if (T[p] == "alias") refuse(path ": an alias (*...)")
  if (T[p] == "value") {
    v = unquote_final(p)
    if (v != "") print v
    exit 0
  }
  # Everything first: a refusal prints nothing else.
  out = ""
  for (i = 1; i <= m; i++) {
    child = p SUBSEP names[i]
    v = out_value(child, (T[p] == "list") ? "a list of plain values" : "a map of plain values")
    if (index(v, "\n") > 0) refuse(path ": " names[i] " has several lines")
    out = out ((T[p] == "list") ? v : names[i] "=" v) "\n"
  }
  printf "%s", out
  exit 0
}
