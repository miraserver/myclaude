#!/usr/bin/env python3
"""Block narrowly defined destructive Bash commands via Claude hook stdin."""
import json
import re
import shlex
import sys

ROOT_TARGETS = {"/", "/*", "~", "~/", "~/*", "$HOME", "${HOME}"}


def dangerous(command):
    if re.search(r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", command):
        return "fork bomb"
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()<>\n")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return None
    segments = [[]]
    for token in tokens:
        if token in (";", "&&", "||", "|", "&", "(", ")", "\n"):
            segments.append([])
        else:
            segments[-1].append(token)
    for words in segments:
        for i, word in enumerate(words):
            if ">" in word and set(word) <= set("<>") and i + 1 < len(words):
                if re.fullmatch(r"/dev/sd[^/]*", words[i + 1]):
                    return "redirect to /dev/sd device"
        # Permit common command wrappers, but don't inspect arguments such as echo text.
        while words and (words[0] in ("sudo", "command", "env") or re.match(r"^[A-Za-z_][A-Za-z_0-9]*=", words[0])):
            words = words[1:]
        if not words:
            continue
        executable = words[0].rsplit("/", 1)[-1]
        if re.fullmatch(r"mkfs\..+", executable):
            return "filesystem formatting"
        if executable == "dd" and any(re.fullmatch(r"of=/dev/(?:[shv]d[a-z]+[0-9]*|xvd[a-z]+[0-9]*|nvme[0-9]+n[0-9]+(?:p[0-9]+)?|mmcblk[0-9]+(?:p[0-9]+)?|r?disk[0-9]+(?:s[0-9]+)?)", arg) for arg in words[1:]):
            return "dd output to disk device"
        if executable == "rm":
            flags, targets, options = set(), [], True
            for arg in words[1:]:
                if options and arg == "--":
                    options = False
                elif options and arg.startswith("--"):
                    flags.update({"--recursive": "r", "--force": "f"}.get(arg, ""))
                elif options and arg.startswith("-"):
                    flags.update(arg[1:].replace("R", "r"))
                else:
                    targets.append(arg)
            if {"r", "f"} <= flags and any(t in ROOT_TARGETS for t in targets):
                return "recursive forced removal of root/home"
    return None


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8-sig", errors="replace"))
        command = data["tool_input"]["command"]
        if not isinstance(command, str):
            return 0
    except (ValueError, TypeError, KeyError):
        return 0
    reason = dangerous(command)
    if reason:
        print(f"[CWF] BLOCKED: {reason}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
