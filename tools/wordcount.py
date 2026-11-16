"""Count prose words in a Markdown file, skipping fenced code, inline code and link targets.

    py tools/wordcount.py README.md
"""
import re
import sys


def prose_words(md: str) -> int:
    md = re.sub(r"```.*?```", " ", md, flags=re.S)          # fenced code
    md = re.sub(r"`[^`]*`", " ", md)                          # inline code
    md = re.sub(r"\]\([^)]*\)", "]", md)                      # link targets
    md = re.sub(r"\*\*README prose word count:.*", " ", md)   # the count line itself
    md = re.sub(r"[|#*>\-]+", " ", md)                        # table/heading/list markup
    return len([w for w in md.split() if re.search(r"[A-Za-z0-9]", w)])


if __name__ == "__main__":
    print(prose_words(open(sys.argv[1], encoding="utf-8").read()))
