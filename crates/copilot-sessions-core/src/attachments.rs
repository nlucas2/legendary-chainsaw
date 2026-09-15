use github_copilot_sdk::types::Attachment;

use crate::{Result, ServiceError};

const MAX_ATTACHMENTS: usize = 5;
const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: usize = 12 * 1024 * 1024;

pub(crate) fn validate_attachments(attachments: &[Attachment], blobs_only: bool) -> Result<()> {
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(invalid("attach at most 5 files per message"));
    }
    let mut total_bytes = 0;
    for attachment in attachments {
        match attachment {
            Attachment::Blob { data, .. } => {
                // Check encoded size before scanning; no decoded file buffer or
                // server filesystem access is needed to enforce the byte caps.
                if data.len() > MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 {
                    return Err(invalid("attachment exceeds the 8 MiB file limit"));
                }
                let bytes = decoded_base64_size(data)?;
                if bytes == 0 {
                    return Err(invalid("empty attachments are not supported"));
                }
                if bytes > MAX_ATTACHMENT_BYTES {
                    return Err(invalid("attachment exceeds the 8 MiB file limit"));
                }
                total_bytes += bytes;
                if total_bytes > MAX_TOTAL_ATTACHMENT_BYTES {
                    return Err(invalid("attachments exceed the 12 MiB message limit"));
                }
            }
            _ if blobs_only => {
                return Err(invalid(
                    "HTTP attachments must be native blobs; server-side file paths and other attachment types are not accepted",
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn invalid(message: &str) -> ServiceError {
    ServiceError::InvalidArgument(message.into())
}

fn decoded_base64_size(data: &str) -> Result<usize> {
    let bytes = data.as_bytes();
    if bytes.is_empty() {
        return Ok(0);
    }
    if bytes.len() % 4 != 0 {
        return Err(invalid("attachment data must be padded standard base64"));
    }
    let padding = if bytes.ends_with(b"==") {
        2
    } else {
        usize::from(bytes.ends_with(b"="))
    };
    let content = &bytes[..bytes.len() - padding];
    if content.iter().any(|byte| sextet(*byte).is_none()) {
        return Err(invalid("attachment data contains invalid base64"));
    }
    let last = content
        .last()
        .and_then(|byte| sextet(*byte))
        .ok_or_else(|| invalid("attachment data contains invalid base64 padding"))?;
    if (padding == 1 && last & 0b11 != 0) || (padding == 2 && last & 0b1111 != 0) {
        return Err(invalid("attachment data contains invalid base64 padding"));
    }
    Ok(bytes.len() / 4 * 3 - padding)
}

fn sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn zero_blob(size: usize) -> Attachment {
        let mut data = "AAAA".repeat(size / 3);
        match size % 3 {
            1 => data.push_str("AA=="),
            2 => data.push_str("AAA="),
            _ => {}
        }
        serde_json::from_value(
            json!({"type":"blob","data":data,"mimeType":"application/octet-stream"}),
        )
        .unwrap()
    }

    #[test]
    fn base64_size_is_validated_without_decoding() {
        assert_eq!(decoded_base64_size("aGk=").unwrap(), 2);
        assert_eq!(decoded_base64_size("QQ==").unwrap(), 1);
        assert_eq!(decoded_base64_size("AAAA").unwrap(), 3);
        for invalid in ["aGk", "====", "AA=A", "AB==", "AAB=", "aG k", "aGk_", "éé"] {
            assert!(decoded_base64_size(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn browser_rejects_paths_empty_files_and_excessive_count() {
        let path: Attachment =
            serde_json::from_value(json!({"type":"file","path":"server-secret.txt"})).unwrap();
        assert!(validate_attachments(&[path.clone()], true).is_err());
        // Trusted in-process consumers retain the native Attachment API.
        assert!(validate_attachments(&[path], false).is_ok());
        assert!(validate_attachments(&[zero_blob(0)], true).is_err());
        assert!(validate_attachments(&vec![zero_blob(1); 6], true).is_err());
    }

    #[test]
    fn decoded_size_caps_accept_boundary_and_reject_overflow() {
        let maximum = zero_blob(MAX_ATTACHMENT_BYTES);
        assert!(validate_attachments(&[maximum.clone()], true).is_ok());
        assert!(validate_attachments(&[zero_blob(MAX_ATTACHMENT_BYTES + 1)], true).is_err());
        assert!(validate_attachments(&[maximum.clone(), zero_blob(4 * 1024 * 1024)], true).is_ok());
        assert!(validate_attachments(&[maximum, zero_blob(4 * 1024 * 1024 + 1)], true).is_err());
    }
}
