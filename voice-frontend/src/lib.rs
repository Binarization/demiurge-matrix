mod nlp;
use anyhow::{bail, Result};
use tokenizers::{Tokenizer, Encoding};
use wasm_bindgen::prelude::*;
use serde::Serialize;

#[wasm_bindgen]
pub struct Frontend { tokenizer: Tokenizer }
#[derive(Serialize)]
struct Inputs {
    normalized: String, phones: Vec<i64>, tones: Vec<i64>, languages: Vec<i64>,
    input_ids: Vec<u32>, attention_mask: Vec<u32>, token_type_ids: Vec<u32>, word2ph: Vec<usize>,
}
#[wasm_bindgen]
impl Frontend {
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> std::result::Result<Frontend, JsValue> {
        let tokenizer = Tokenizer::from_bytes(json.as_bytes()).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Self { tokenizer })
    }
    pub fn prepare(&self, text: &str) -> std::result::Result<String, JsValue> {
        self.prepare_inner(text).and_then(|x| Ok(serde_json::to_string(&x)?))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
impl Frontend {
    fn prepare_inner(&self, text: &str) -> Result<Inputs> {
        if text.trim().is_empty() || text.chars().count() > 300 { bail!("Each speech chunk must contain 1–300 characters"); }
        let normalized = nlp::chinese::normalizer::normalize_text(text);
        let (phones, tones, mut counts, english) = nlp::chinese::g2p::g2p(&normalized)?;
        let mut ids = Vec::new(); let mut ts = Vec::new(); let mut langs = Vec::new();
        let mut at = 0;
        for count in &mut counts {
            let mut kept = 0;
            for _ in 0..*count {
                if at >= phones.len() { bail!("Invalid phone alignment"); }
                if let Some(&id) = nlp::SYMBOL_ID_MAP.get(phones[at].as_str()) {
                    ids.push(id as i64); ts.push(tones[at] as i64 + if english[at] {8} else {0});
                    langs.push(if english[at] {2} else {0}); kept += 1;
                }
                at += 1;
            }
            *count = kept * 2;
        }
        if ids.is_empty() { bail!("No recognizable phones"); }
        counts[0] += 1;
        let encoding = self.tokenizer.encode(normalized.as_str(), true).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let word2ph = align_word2ph(&normalized, &counts, &encoding)?;
        let phones = blanks(&ids);
        if word2ph.iter().sum::<usize>() != phones.len() { bail!("Tokenizer/phone alignment mismatch"); }
        Ok(Inputs { normalized, phones, tones: blanks(&ts), languages: blanks(&langs),
            input_ids: encoding.get_ids().to_vec(), attention_mask: encoding.get_attention_mask().to_vec(),
            token_type_ids: encoding.get_type_ids().to_vec(), word2ph })
    }
}
fn blanks(values: &[i64]) -> Vec<i64> {
    let mut out = vec![0]; for v in values { out.push(*v); out.push(0); } out
}
fn align_word2ph(text: &str, word2ph: &[usize], encoding: &Encoding) -> Result<Vec<usize>> {
    if word2ph.is_empty() {
        bail!("word2ph is empty");
    }
    let offsets = encoding.get_offsets();
    if offsets.is_empty() {
        bail!("BERT encoding produced no offsets");
    }

    let leading = word2ph[0];
    let trailing = *word2ph.last().unwrap();

    let mut char_spans = Vec::new();
    let char_iter = text.char_indices();
    for (idx, (start, ch)) in char_iter.enumerate() {
        let end = start + ch.len_utf8();
        let count_idx = idx + 1;
        if count_idx >= word2ph.len() {
            bail!("word2ph length mismatch with text characters");
        }
        char_spans.push((start, end, word2ph[count_idx]));
    }

    if word2ph.len() != char_spans.len() + 2 {
        bail!("word2ph length does not equal text characters + 2");
    }

    let mut result = Vec::with_capacity(offsets.len());
    let mut char_index = 0usize;
    for (token_idx, &(start, end)) in offsets.iter().enumerate() {
        if token_idx == 0 {
            result.push(leading);
            continue;
        }
        if token_idx == offsets.len() - 1 {
            result.push(trailing);
            continue;
        }

        if start == 0 && end == 0 {
            result.push(0);
            continue;
        }

        let mut total = 0usize;
        let mut temp_index = char_index;
        while temp_index < char_spans.len() {
            let (c_start, c_end, count) = char_spans[temp_index];
            if c_end <= start {
                temp_index += 1;
                continue;
            }
            if c_start >= end {
                break;
            }
            total += count;
            temp_index += 1;
        }
        char_index = temp_index;
        result.push(total);
    }

    Ok(result)
}
