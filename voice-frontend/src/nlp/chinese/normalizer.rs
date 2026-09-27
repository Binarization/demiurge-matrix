use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;

use super::cn2an;
use crate::nlp::PUNCTUATIONS;

static REPLACE_MAP: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    HashMap::from([
        ("：", ","),
        ("；", ","),
        ("，", ","),
        ("。", "."),
        ("！", "!"),
        ("？", "?"),
        ("\n", "."),
        ("·", ","),
        ("、", ","),
        ("...", "…"),
        ("$", "."),
        ("“", "'"),
        ("”", "'"),
        ("\"", "'"),
        ("‘", "'"),
        ("’", "'"),
        ("（", "'"),
        ("）", "'"),
        ("(", "'"),
        (")", "'"),
        ("《", "'"),
        ("》", "'"),
        ("【", "'"),
        ("】", "'"),
        ("[", "'"),
        ("]", "'"),
        ("—", "-"),
        ("～", "-"),
        ("~", "-"),
        ("「", "'"),
        ("」", "'"),
    ])
});

static REPLACE_PATTERN: Lazy<Regex> = Lazy::new(|| {
    let mut escaped: Vec<String> = REPLACE_MAP.keys().map(|s| regex::escape(s)).collect();
    escaped.sort_by(|a, b| b.len().cmp(&a.len()));
    let joined = escaped.join("|");
    Regex::new(&joined).expect("replace regex")
});

static NON_CHINESE_PATTERN: Lazy<Regex> = Lazy::new(|| {
    let punct = PUNCTUATIONS
        .iter()
        .map(|p| regex::escape(p))
        .collect::<Vec<_>>()
        .join("");
    Regex::new(&format!(r"[^\u4e00-\u9fa5A-Za-z0-9\s{punct}]+")).expect("non chinese regex")
});

pub fn normalize_text(text: &str) -> String {
    let text = cn2an::replace_numbers(text);
    replace_punctuation(&text)
}

pub fn replace_punctuation(text: &str) -> String {
    let replaced = REPLACE_PATTERN.replace_all(text, |caps: &regex::Captures| {
        REPLACE_MAP
            .get(caps.get(0).unwrap().as_str())
            .copied()
            .unwrap_or("")
    });
    let replaced = replaced.replace("嗯", "恩").replace("呣", "母");
    NON_CHINESE_PATTERN.replace_all(&replaced, "").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_numbers_and_punctuation() {
        assert_eq!(
            normalize_text("你好，世界！123abc"),
            "你好,世界!一百二十三abc"
        );
    }
}
