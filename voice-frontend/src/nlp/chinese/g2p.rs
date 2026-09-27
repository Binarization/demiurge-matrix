use std::collections::HashMap;

use anyhow::{Context, Result, bail};
use jieba_rs::Jieba;
use once_cell::sync::Lazy;
use pinyin::{Pinyin, ToPinyin};

use crate::nlp::PUNCTUATIONS;

use super::tone_sandhi::{TONE_SANDHI, ToneSandhi};
use crate::nlp::english;

static PINYIN_TO_SYMBOL_MAP: Lazy<HashMap<String, Vec<String>>> = Lazy::new(|| {
    let data = include_str!("../../../resources/opencpop-strict.txt");
    data.lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let key = parts.next()?.trim().to_string();
            let values = parts.next().map(|rest| {
                rest.split_whitespace()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })?;
            Some((key, values))
        })
        .collect()
});

static JIEBA: Lazy<Jieba> = Lazy::new(Jieba::new);

const PINYIN_INITIALS: [&str; 23] = [
    "zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r",
    "z", "c", "s", "y", "w",
];

/// 第四个返回值 `is_english`：与 `phones`/`tones` 一一对应，标记该音素是否来自
/// `english::g2p_word`。上游调用方（`model::infer_chinese`）用它给每个音素分别
/// 选 tone 偏移与 language id，而不是把整句一律当中文——见该函数调用处的注释，
/// 这是修「中英混排时英文发音不对」这个问题的关键：不分语言的版本会把英文的
/// 重音值直接当成中文声调 id 用（两者共享 0~3 的数值范围，会撞进错的 embedding），
/// 也会把英文音素标成中文语言 id。
pub fn g2p(text: &str) -> Result<(Vec<String>, Vec<i32>, Vec<usize>, Vec<bool>)> {
    let tone_modifier: &ToneSandhi = &TONE_SANDHI;
    let mut phones = Vec::new();
    let mut tones = Vec::new();
    let mut word2ph = Vec::new();
    let mut is_english = Vec::new();

    for sentence in split_sentences(text) {
        let trimmed = sentence.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Preserve leading/trailing whitespace when processing so word2ph indices
        // continue to line up with the original text.
        let (seg_phones, seg_tones, seg_word2ph, seg_is_english) =
            process_sentence(&sentence, tone_modifier)?;
        phones.extend(seg_phones);
        tones.extend(seg_tones);
        word2ph.extend(seg_word2ph);
        is_english.extend(seg_is_english);
    }

    phones.insert(0, "_".into());
    phones.push("_".into());
    tones.insert(0, 0);
    tones.push(0);
    is_english.insert(0, false);
    is_english.push(false);
    word2ph.insert(0, 1);
    word2ph.push(1);

    let expected_len = text.chars().count() + 2;
    if word2ph.len() < expected_len {
        let deficit = expected_len - word2ph.len();
        word2ph.extend(std::iter::repeat(0).take(deficit));
    } else if word2ph.len() > expected_len {
        word2ph.truncate(expected_len);
    }
    if let Some(first) = word2ph.first_mut() {
        *first = 1;
    }
    if let Some(last) = word2ph.last_mut() {
        *last = 1;
    }

    let chars: Vec<char> = text.chars().collect();
    for (idx, &ch) in chars.iter().enumerate() {
        if ch.is_ascii_whitespace() {
            let pos = idx + 1;
            if pos < word2ph.len().saturating_sub(1) {
                word2ph[pos] = 0;
            }
        }
    }

    let sum = word2ph.iter().map(|&v| v as isize).sum::<isize>();
    let target = phones.len() as isize;
    if sum != target {
        if sum < target {
            let mut remaining = target - sum;
            for (idx, &ch) in chars.iter().enumerate() {
                if remaining == 0 {
                    break;
                }
                let pos = idx + 1;
                if pos >= word2ph.len().saturating_sub(1) {
                    continue;
                }
                if ch.is_ascii_whitespace() {
                    continue;
                }
                word2ph[pos] += 1;
                remaining -= 1;
            }
            if remaining > 0 {
                if let Some(last) = word2ph.last_mut() {
                    *last += remaining as usize;
                }
            }
        } else {
            let mut remaining = sum - target;
            for (idx, &ch) in chars.iter().enumerate().rev() {
                if remaining == 0 {
                    break;
                }
                let pos = idx + 1;
                if pos >= word2ph.len().saturating_sub(1) {
                    continue;
                }
                if word2ph[pos] == 0 {
                    continue;
                }
                if ch.is_ascii_whitespace() {
                    continue;
                }
                let reduce = remaining.min(word2ph[pos] as isize);
                word2ph[pos] -= reduce as usize;
                remaining -= reduce;
            }
            if remaining > 0 {
                if let Some(last) = word2ph.last_mut() {
                    let reduce = remaining.min(*last as isize);
                    *last -= reduce as usize;
                }
            }
        }
    }

    if let Some(first) = word2ph.first_mut() {
        *first = 1;
    }
    if let Some(last) = word2ph.last_mut() {
        if *last == 0 {
            *last = 1;
        }
    }

    Ok((phones, tones, word2ph, is_english))
}

fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if is_punctuation_char(ch) {
            if !current.trim().is_empty() {
                sentences.push(current.clone());
            }
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        sentences.push(current);
    }
    sentences
}

fn process_sentence(
    sentence: &str,
    tone_modifier: &ToneSandhi,
) -> Result<(Vec<String>, Vec<i32>, Vec<usize>, Vec<bool>)> {
    let mut tagged: Vec<(String, String)> = JIEBA
        .tag(sentence, true)
        .into_iter()
        .map(|t| (t.word.to_string(), t.tag.to_string()))
        .collect();
    tagged = tone_modifier.pre_merge_for_modify(tagged);

    let mut phones = Vec::new();
    let mut tones = Vec::new();
    let mut word2ph = Vec::new();
    let mut is_english = Vec::new();

    for (word, pos) in tagged {
        if word.chars().all(|c| c.is_whitespace()) {
            let count = word.chars().count();
            word2ph.extend(std::iter::repeat(0).take(count));
            continue;
        }
        if word.trim().is_empty() {
            continue;
        }
        if english::is_english_token(&word) {
            let eng = english::g2p_word(&word);
            for (ph, tone) in eng.phones.iter().zip(eng.tones.iter()) {
                phones.push(ph.clone());
                tones.push(*tone);
                is_english.push(true);
            }
            word2ph.extend(eng.char_phone_counts);
            continue;
        }
        let mut syllables = get_syllables(&word);
        if syllables.is_empty() {
            continue;
        }
        if syllables
            .iter()
            .any(|s| s.final_with_tone.chars().any(|c| c.is_ascii_alphabetic()))
        {
            let finals: Vec<String> = syllables
                .iter()
                .map(|s| s.final_with_tone.clone())
                .collect();
            let adjusted = tone_modifier.modified_tone(&word, &pos, finals);
            for (syllable, final_with_tone) in syllables.iter_mut().zip(adjusted.into_iter()) {
                syllable.final_with_tone = final_with_tone;
            }
        }

        for syllable in syllables {
            let (char_phones, tone) = map_syllable_to_phones(&syllable).with_context(|| {
                format!(
                    "failed to map syllable '{}' in word '{}'",
                    syllable.ch, word
                )
            })?;
            let count = char_phones.len();
            phones.extend(char_phones);
            tones.extend(std::iter::repeat(tone).take(count));
            is_english.extend(std::iter::repeat(false).take(count));
            word2ph.push(count);
        }
    }

    Ok((phones, tones, word2ph, is_english))
}

struct SyllableInfo {
    ch: char,
    initial: String,
    final_with_tone: String,
}

fn get_syllables(word: &str) -> Vec<SyllableInfo> {
    word.chars()
        .zip(word.to_pinyin())
        .map(|(ch, opt)| match opt {
            Some(py) => {
                let (initial, final_with_tone) = split_initial_and_final(py, ch);
                SyllableInfo {
                    ch,
                    initial,
                    final_with_tone,
                }
            }
            None => {
                let fallback = ch.to_string();
                SyllableInfo {
                    ch,
                    initial: fallback.clone(),
                    final_with_tone: fallback,
                }
            }
        })
        .collect()
}

fn map_syllable_to_phones(info: &SyllableInfo) -> Result<(Vec<String>, i32)> {
    if info.initial == info.final_with_tone {
        return Ok((vec![info.ch.to_string()], 0));
    }

    let tone_char = info.final_with_tone.chars().last().unwrap_or('0');
    let tone = tone_char.to_digit(10).unwrap_or(0) as i32;

    let mut final_body = info
        .final_with_tone
        .trim_end_matches(|c: char| c.is_ascii_digit())
        .replace('ü', "v");

    if final_body == "lü" {
        final_body = "lv".to_string();
    }

    let mut pinyin = if info.initial.is_empty() {
        adjust_vowel_pinyin(final_body.clone())
    } else {
        adjust_consonant_pinyin(&info.initial, final_body.clone())
    };

    if pinyin.is_empty() {
        pinyin = info.ch.to_string();
    }

    if let Some(symbols) = PINYIN_TO_SYMBOL_MAP.get(&pinyin) {
        Ok((symbols.clone(), tone))
    } else if info.initial.is_empty() && is_punctuation_char(info.ch) {
        Ok((vec![info.ch.to_string()], 0))
    } else {
        bail!("no phone mapping for pinyin '{}'", pinyin)
    }
}

fn adjust_consonant_pinyin(initial: &str, final_body: String) -> String {
    let replaced = match final_body.as_str() {
        "uei" => "ui",
        "iou" => "iu",
        "uen" => "un",
        _ => final_body.as_str(),
    };
    format!("{}{}", initial, replaced)
}

fn adjust_vowel_pinyin(pinyin: String) -> String {
    match pinyin.as_str() {
        "ing" => "ying".to_string(),
        "i" => "yi".to_string(),
        "in" => "yin".to_string(),
        "u" => "wu".to_string(),
        _ => {
            if let Some(first) = pinyin.chars().next() {
                let rest: String = pinyin.chars().skip(1).collect();
                match first {
                    'v' => format!("yu{}", rest),
                    'e' => format!("e{}", rest),
                    'i' => format!("y{}", rest),
                    'u' => format!("w{}", rest),
                    _ => pinyin,
                }
            } else {
                pinyin
            }
        }
    }
}

fn is_punctuation_char(ch: char) -> bool {
    PUNCTUATIONS.iter().any(|p| p.chars().next() == Some(ch))
}

pub(crate) fn finals_with_tone(word: &str) -> Vec<String> {
    word.chars()
        .zip(word.to_pinyin())
        .map(|(ch, opt)| match opt {
            Some(py) => {
                let (_, finals) = split_initial_and_final(py, ch);
                finals
            }
            None => ch.to_string(),
        })
        .collect()
}

fn split_initial_and_final(py: Pinyin, fallback_char: char) -> (String, String) {
    let plain = py.plain();
    let with_tone_end = py.with_tone_num_end();
    let initial = extract_initial(plain);
    let finals = with_tone_end.get(initial.len()..).unwrap_or("").to_string();
    let finals = if finals.is_empty() {
        fallback_char.to_string()
    } else {
        finals
    };
    (initial.to_string(), finals)
}

fn extract_initial(plain: &str) -> &str {
    for candidate in PINYIN_INITIALS {
        if plain.starts_with(candidate) {
            return candidate;
        }
    }
    ""
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g2p_single_character() {
        let (phones, tones, word2ph, _) = g2p("你").expect("g2p succeeds");
        assert_eq!(phones, vec!["_", "n", "i", "_"]);
        assert_eq!(tones, vec![0, 3, 3, 0]);
        assert_eq!(word2ph, vec![1, 2, 1]);
    }

    #[test]
    fn g2p_applies_tone_sandhi() {
        let (phones, tones, word2ph, _) = g2p("你好").expect("g2p succeeds");
        assert_eq!(phones, vec!["_", "n", "i", "h", "ao", "_"]);
        assert_eq!(tones, vec![0, 2, 2, 3, 3, 0]);
        assert_eq!(word2ph, vec![1, 2, 2, 1]);
    }

    #[test]
    fn finals_with_tone_extraction() {
        assert_eq!(
            finals_with_tone("不对"),
            vec!["u4".to_string(), "ui4".to_string()]
        );
    }

    #[test]
    fn g2p_mixed_language() {
        let (phones, tones, word2ph, _) = g2p("Hello世界").expect("g2p succeeds");
        assert!(phones.iter().any(|p| p == "hh"));
        assert!(phones.iter().any(|p| p == "sh"));
        assert_eq!(phones.len(), tones.len());
        assert_eq!(word2ph.iter().sum::<usize>(), phones.len());
    }

    #[test]
    fn g2p_mixed_language_complex() {
        let text = "你好，欢迎使用风格语音合成Style-Bert-VITS2 ONNX TTS";
        let normalized = crate::nlp::chinese::normalizer::normalize_text(text);
        let (phones, _tones, word2ph, _) = g2p(&normalized).expect("g2p succeeds");
        let sum: usize = word2ph.iter().sum();
        assert_eq!(word2ph.len(), normalized.chars().count() + 2);
        assert_eq!(phones.len(), sum);
        assert!(phones.len() > 0);
    }

    #[test]
    fn g2p_english_sentence() {
        let text = "Occasionally give me gifts, and have special interactions with me on special holidays.";
        let normalized = crate::nlp::chinese::normalizer::normalize_text(text);
        let (phones, _tones, word2ph, _) = g2p(&normalized).expect("g2p succeeds");
        let sum: usize = word2ph.iter().sum();
        assert_eq!(word2ph.len(), normalized.chars().count() + 2);
        assert_eq!(phones.len(), sum);
        assert!(phones.len() > 0);
    }

    #[test]
    fn g2p_preserves_whitespace_around_tilde() {
        let text = "Hello ~ 世界";
        let normalized = crate::nlp::chinese::normalizer::normalize_text(text);
        assert!(
            normalized.contains('-'),
            "normalizer should convert '~' into '-'"
        );
        let (_phones, _tones, word2ph, _) = g2p(&normalized).expect("g2p succeeds");
        assert_eq!(word2ph.len(), normalized.chars().count() + 2);
        for (idx, ch) in normalized.chars().enumerate() {
            if ch.is_ascii_whitespace() {
                assert_eq!(
                    word2ph[idx + 1],
                    0,
                    "expected whitespace at char index {idx}"
                );
            }
        }
    }

    #[test]
    fn g2p_long_romantic_phrase() {
        let text = "嗨！是命运的邂逅吗，还是……久别重逢呢？ 真让人心跳加速呀！那么，就像初遇时那样，再一次呼唤我『昔涟』，好吗？ 我是昔涟，很高兴见到你，我的伙伴！";
        let normalized = crate::nlp::chinese::normalizer::normalize_text(text);
        let (phones, tones, word2ph, _) = g2p(&normalized).expect("g2p succeeds");
        println!("Normalized text: {normalized}");
        println!("Phones: {phones:?}");
        println!("Tones: {tones:?}");
        println!("word2ph: {word2ph:?}");
        assert_eq!(
            word2ph.len(),
            normalized.chars().count() + 2,
            "word2ph should align to normalized text"
        );
        assert_eq!(phones.len(), tones.len(), "phones/tones length mismatch");
        assert_eq!(
            phones.len(),
            word2ph.iter().sum::<usize>(),
            "word2ph count should equal phones"
        );
        // 嗨 -> h + ai; ensure those phones exist to confirm the first word was processed.
        assert!(
            phones.windows(2).any(|w| w[0] == "h" && w[1] == "ai"),
            "expected to find phones for '嗨'"
        );
        // 昔 -> x + i, 涟 -> l + ian; ensure Sino-specific phones present.
        assert!(
            phones.contains(&"x".to_string()) && phones.contains(&"ian".to_string()),
            "expected Style-Bert phones for '昔涟'"
        );
    }
}
