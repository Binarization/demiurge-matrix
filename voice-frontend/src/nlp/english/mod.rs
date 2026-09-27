use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use once_cell::sync::Lazy;

use crate::nlp::PUNCTUATIONS;

static CMU_DICT: Lazy<HashMap<String, Vec<Vec<String>>>> = Lazy::new(load_cmudict);
static ARPA_SET: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "AH0", "S", "AH1", "EY2", "AE2", "EH0", "OW2", "UH0", "NG", "B", "G", "AY0", "M", "AA0",
        "F", "AO0", "ER2", "UH1", "IY1", "AH2", "DH", "IY0", "EY1", "IH0", "K", "N", "W", "IY2",
        "T", "AA1", "ER1", "EH2", "OY0", "UH2", "UW1", "Z", "AW2", "AW1", "V", "UW2", "AA2", "ER",
        "AW0", "UW0", "R", "OW1", "EH1", "ZH", "AE0", "IH2", "IH", "Y", "JH", "P", "AY1", "EY0",
        "OY2", "TH", "HH", "D", "ER0", "CH", "AO1", "AE1", "AO2", "OY1", "AY2", "IH1", "OW0", "L",
        "SH",
    ]
    .into_iter()
    .collect()
});

static ENGLISH_G2P_CACHE: Lazy<Mutex<HashMap<String, EnglishG2pResult>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
pub struct EnglishG2pResult {
    pub phones: Vec<String>,
    pub tones: Vec<i32>,
    pub char_phone_counts: Vec<usize>,
}

pub fn is_english_token(token: &str) -> bool {
    token
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '\'' || ch == '-')
}

pub fn g2p_word(token: &str) -> EnglishG2pResult {
    if let Some(cached) = ENGLISH_G2P_CACHE.lock().unwrap().get(token).cloned() {
        return cached;
    }

    if token.trim().is_empty() {
        return EnglishG2pResult {
            phones: Vec::new(),
            tones: Vec::new(),
            char_phone_counts: vec![0],
        };
    }

    let chars: Vec<char> = token.chars().collect();
    if chars.is_empty() {
        return EnglishG2pResult {
            phones: vec!["UNK".to_string()],
            tones: vec![0],
            char_phone_counts: vec![1],
        };
    }

    let mut phones = Vec::new();
    let mut tones = Vec::new();
    let mut char_counts = Vec::with_capacity(chars.len());

    let mut idx = 0;
    while idx < chars.len() {
        let ch = chars[idx];
        if ch.is_ascii_alphabetic() {
            let start = idx;
            while idx < chars.len() && chars[idx].is_ascii_alphabetic() {
                idx += 1;
            }
            let segment: String = chars[start..idx].iter().collect();
            let (seg_phones, seg_tones) = g2p_alpha_segment(&segment);
            let distribution = distribute(seg_phones.len(), segment.len());
            phones.extend(seg_phones);
            tones.extend(seg_tones);
            char_counts.extend(distribution);
            continue;
        }
        if ch.is_ascii_digit() {
            let mapping = digit_mapping(ch);
            let len = mapping.len();
            phones.extend(mapping.iter().map(|&s| s.to_string()));
            tones.extend(std::iter::repeat(0).take(len));
            char_counts.push(len);
            idx += 1;
            continue;
        }
        if ch == '\'' || ch == '-' {
            phones.push(ch.to_string());
            tones.push(0);
            char_counts.push(1);
            idx += 1;
            continue;
        }
        if PUNCTUATIONS.iter().any(|p| p.starts_with(ch)) {
            phones.push(ch.to_string());
            tones.push(0);
            char_counts.push(1);
            idx += 1;
            continue;
        }
        phones.push("UNK".to_string());
        tones.push(0);
        char_counts.push(1);
        idx += 1;
    }

    if phones.is_empty() {
        phones.push("UNK".to_string());
        tones.push(0);
    }

    if char_counts.is_empty() {
        char_counts.push(phones.len());
    }

    let result = EnglishG2pResult {
        phones,
        tones,
        char_phone_counts: char_counts,
    };

    ENGLISH_G2P_CACHE
        .lock()
        .unwrap()
        .insert(token.to_string(), result.clone());

    result
}

fn g2p_alpha_segment(segment: &str) -> (Vec<String>, Vec<i32>) {
    if let Some(entries) = CMU_DICT.get(&segment.to_uppercase()) {
        let mut phones = Vec::new();
        let mut tones = Vec::new();
        for syllable in entries {
            for ph in syllable {
                let (p, t) = refine_phoneme(ph);
                phones.push(p);
                tones.push(t);
            }
        }
        if !phones.is_empty() {
            return (phones, tones);
        }
    }

    if segment.chars().all(|c| c.is_ascii_uppercase()) && segment.len() > 1 {
        let mut phones = Vec::new();
        let mut tones = Vec::new();
        for ch in segment.chars() {
            let (p, t) = g2p_alpha_segment(&ch.to_string());
            phones.extend(p);
            tones.extend(t);
        }
        if !phones.is_empty() {
            return (phones, tones);
        }
    }

    fallback_alpha_segment(segment)
}

fn fallback_alpha_segment(segment: &str) -> (Vec<String>, Vec<i32>) {
    let mut phones = Vec::new();
    let mut tones = Vec::new();
    for ch in segment.chars() {
        let symbol = match ch.to_ascii_lowercase() {
            'a' => "ey",
            'b' => "b",
            'c' => "k",
            'd' => "d",
            'e' => "iy",
            'f' => "f",
            'g' => "g",
            'h' => "hh",
            'i' => "ay",
            'j' => "jh",
            'k' => "k",
            'l' => "l",
            'm' => "m",
            'n' => "n",
            'o' => "ow",
            'p' => "p",
            'q' => "k",
            'r' => "r",
            's' => "s",
            't' => "t",
            'u' => "uw",
            'v' => "v",
            'w' => "w",
            'x' => "k",
            'y' => "y",
            'z' => "z",
            _ => "unk",
        };
        phones.push(symbol.to_string());
        tones.push(0);
    }
    (phones, tones)
}

fn distribute(total: usize, slots: usize) -> Vec<usize> {
    let mut result = vec![0usize; slots];
    if slots == 0 {
        return result;
    }
    for _ in 0..total {
        let idx = result
            .iter()
            .enumerate()
            .min_by_key(|(_, v)| **v)
            .map(|(i, _)| i)
            .unwrap_or(0);
        result[idx] += 1;
    }
    result
}

fn digit_mapping(ch: char) -> Vec<&'static str> {
    match ch {
        '0' => vec!["z", "iy", "r", "ow"],
        '1' => vec!["w", "ah", "n"],
        '2' => vec!["t", "uw"],
        '3' => vec!["th", "r", "iy"],
        '4' => vec!["f", "ao", "r"],
        '5' => vec!["f", "ay", "v"],
        '6' => vec!["s", "ih", "k", "s"],
        '7' => vec!["s", "eh", "v", "ah", "n"],
        '8' => vec!["ey", "t"],
        '9' => vec!["n", "ay", "n"],
        _ => vec!["unk"],
    }
}

fn load_cmudict() -> HashMap<String, Vec<Vec<String>>> {
    let mut dict = HashMap::new();
    let data = include_str!("../../../resources/cmudict.rep");
    for (idx, line) in data.lines().enumerate() {
        if idx < 48 {
            continue;
        }
        if let Some((word, rest)) = line.split_once("  ") {
            let syllables: Vec<Vec<String>> = rest
                .split(" - ")
                .map(|syllable| syllable.split(' ').map(|s| s.to_string()).collect())
                .collect();
            dict.insert(word.to_string(), syllables);
        }
    }
    dict
}

fn refine_phoneme(phn: &str) -> (String, i32) {
    let mut base = phn.trim();
    let mut tone = 3;
    if let Some(last) = base.chars().last() {
        if last.is_ascii_digit() {
            tone = last.to_digit(10).unwrap_or(0) as i32 + 1;
            base = &base[..base.len() - 1];
        }
    }
    let symbol = base.to_lowercase();
    if ARPA_SET.contains(phn) {
        (symbol, tone)
    } else {
        (symbol, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionary_word() {
        let result = g2p_word("hello");
        assert!(!result.phones.is_empty());
        assert_eq!(result.char_phone_counts.len(), "hello".chars().count());
        assert_eq!(
            result.char_phone_counts.iter().sum::<usize>(),
            result.phones.len()
        );
    }

    #[test]
    fn fallback_letters() {
        let result = g2p_word("xyz");
        assert_eq!(result.phones.len(), result.tones.len());
        assert_eq!(
            result.char_phone_counts.iter().sum::<usize>(),
            result.phones.len()
        );
    }

    #[test]
    fn acronym_letters_split() {
        let result = g2p_word("CG");
        assert_eq!(result.char_phone_counts.len(), 2);
        assert_eq!(result.phones.len(), result.tones.len());
        assert_eq!(
            result.char_phone_counts.iter().sum::<usize>(),
            result.phones.len()
        );
        assert!(result.phones.len() >= 2);
    }
}
