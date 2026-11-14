from __future__ import annotations

import hashlib
import json
import sys
import types

import pytest

from ai.vietocr_v2.artifact_store import assemble_shards, shard_file
from ai.vietocr_v2.contracts import (
    DatasetContractError,
    DatasetRow,
    assert_original_vocabulary,
    load_jsonl,
    normalize_label,
    stable_split,
    validate_rows,
    vocabulary_fingerprint,
    write_jsonl,
)
from ai.vietocr_v2.metrics import PairedLine, benchmark_metrics, edit_distance
from ai.vietocr_v2.quality_gate import GatePolicy, evaluate_gate
from ai.vietocr_v2.flow2_register import _locked_test_rows, _read_trdg_provenance
from ai.vietocr_v2.flow2_prepare import match_external_annotations
from ai.vietocr_v2.train import (
    PROFILES,
    _WidthBucketBatchSampler,
    _install_vietocr_numpy_bytes_compatibility,
    _should_resume,
    validate_flow1_sample_counts,
)
from ai.vietocr_v2.trdg_generate import generate_trdg


def test_t01_vietnamese_text_is_normalized_to_nfc():
    assert normalize_label("a\u0301") == "á"


def test_t02_blank_ground_truth_is_rejected():
    with pytest.raises(DatasetContractError):
        normalize_label("  \n")


def test_t03_vocabulary_fingerprint_is_stable():
    expected = hashlib.sha256(b'"a"').hexdigest()
    assert vocabulary_fingerprint("a") == (1, expected)


def test_t04_non_original_vocabulary_is_rejected():
    with pytest.raises(DatasetContractError, match="vocabulary"):
        assert_original_vocabulary("a")


def test_t05_page_group_split_is_deterministic():
    assert stable_split("page-1") == stable_split("page-1")


def test_t06_same_group_cannot_leak_between_splits():
    rows = [
        DatasetRow("a.png", "a", "page", "FLOW1_VERIFIED", "train", verified=True),
        DatasetRow("b.png", "b", "page", "FLOW1_VERIFIED", "validation", verified=True),
    ]
    with pytest.raises(DatasetContractError, match="leakage"):
        validate_rows(rows)


def test_t07_flow1_requires_admin_verified_revision():
    with pytest.raises(DatasetContractError, match="VERIFIED"):
        DatasetRow.from_mapping({"image": "x", "label": "xin", "group_id": "p",
                                 "source_flow": "FLOW1_VERIFIED", "split": "train"})


def test_t08_external_labels_require_annotation_provenance():
    with pytest.raises(DatasetContractError, match="annotation_id"):
        DatasetRow.from_mapping({"image": "x", "label": "xin", "group_id": "p",
                                 "source_flow": "FLOW2_EXTERNAL", "split": "train"})


def test_t09_synthetic_rows_cannot_claim_admin_verification():
    with pytest.raises(DatasetContractError, match="synthetic"):
        DatasetRow.from_mapping({"image": "x", "label": "xin", "group_id": "p",
                                 "source_flow": "FLOW2_TRDG", "split": "train", "verified": True})


def test_t10_independent_flows_cannot_be_mixed_in_a_profile_manifest():
    rows = [
        DatasetRow("a", "a", "a", "FLOW1_VERIFIED", "train", verified=True),
        DatasetRow("b", "b", "b", "FLOW2_TRDG", "train"),
    ]
    with pytest.raises(DatasetContractError, match="independent"):
        validate_rows(rows, expected_flow="FLOW1_VERIFIED")


def test_t11_image_hash_must_be_sha256():
    with pytest.raises(DatasetContractError, match="image_sha256"):
        DatasetRow.from_mapping({"image": "x", "label": "xin", "group_id": "p", "source_flow": "FLOW2_TRDG",
                                 "split": "train", "image_sha256": "deadbeef"})


def test_t11a_duplicate_image_content_is_rejected_even_when_paths_differ():
    digest = hashlib.sha256(b"same image bytes").hexdigest()
    rows = [
        DatasetRow("real.png", "xin", "page", "FLOW2_EXTERNAL", "train", digest, True, "ann-1"),
        DatasetRow("synthetic.png", "xin", "label", "FLOW2_TRDG", "train", digest),
    ]
    with pytest.raises(DatasetContractError, match="duplicate image content"):
        validate_rows(rows)


def test_t12_locked_test_cannot_enter_a_training_manifest():
    with pytest.raises(DatasetContractError, match="separately sealed"):
        DatasetRow.from_mapping({"image": "x", "label": "xin", "group_id": "p", "source_flow": "FLOW2_TRDG",
                                 "split": "locked_test"})


def test_t13_levenshtein_distance_is_exact():
    assert edit_distance("kitten", "sitting") == 3


def test_t14_cer_keeps_vietnamese_diacritics():
    line = PairedLine("page", "á", "á", "a", "sample")
    result = benchmark_metrics([line], replicates=50, seed=11)
    assert result["cer"]["candidate_error_count"] == 1


def test_t15_wer_keeps_punctuation_tokens():
    line = PairedLine("page", "xin chào,", "xin chào,", "xin chào", "sample")
    result = benchmark_metrics([line], replicates=50, seed=11)
    assert result["wer"]["candidate_error_count"] == 1


def test_t16_cluster_bootstrap_is_reproducible():
    rows = [PairedLine("page-a", "abc", "abc", "ab", "1"), PairedLine("page-b", "def", "def", "de", "2")]
    assert benchmark_metrics(rows, replicates=100, seed=9) == benchmark_metrics(rows, replicates=100, seed=9)


def test_t17_cluster_bootstrap_uses_document_groups():
    rows = [PairedLine("page-a", "abc", "abc", "ab", "1"), PairedLine("page-a", "def", "def", "de", "2")]
    result = benchmark_metrics(rows, replicates=100, seed=9)
    assert result["group_count"] == 1
    assert result["cer"]["cluster_count"] == 1


def _metrics(status: str = "win"):
    ci = [-0.02, -0.01] if status == "win" else ([0.0, 0.0] if status == "neutral" else [0.01, 0.02])
    return {"sample_count": 200, "group_count": 30,
            "cer": {"original_rate": 0.2, "candidate_rate": 0.1, "delta_candidate_minus_original": -0.1,
                    "paired_cluster_bootstrap_95ci": ci},
            "wer": {"original_rate": 0.3, "candidate_rate": 0.2, "delta_candidate_minus_original": -0.1,
                    "paired_cluster_bootstrap_95ci": ci}}


def test_t18_locked_test_manifest_hash_mismatch_fails_closed():
    result = evaluate_gate(_metrics(), paired_manifest_hash="wrong", expected_locked_manifest_hash="right")
    assert result["status"] == "EVALUATION_FAILED" and result["promotion_allowed"] is False


def test_t19_small_locked_test_is_insufficient_evidence():
    metrics = _metrics()
    metrics["sample_count"] = 2
    result = evaluate_gate(metrics, paired_manifest_hash="h", expected_locked_manifest_hash="h")
    assert result["status"] == "INSUFFICIENT_EVIDENCE"


def test_t20_non_regression_limit_blocks_promotion():
    metrics = _metrics()
    metrics["cer"]["delta_candidate_minus_original"] = 0.01
    result = evaluate_gate(metrics, paired_manifest_hash="h", expected_locked_manifest_hash="h")
    assert result["status"] == "ORIGINAL_WIN" and not result["promotion_allowed"]


def test_t21_neutral_paired_result_does_not_promote():
    result = evaluate_gate(_metrics("neutral"), paired_manifest_hash="h", expected_locked_manifest_hash="h")
    assert result["status"] == "NO_SIGNIFICANT_DIFFERENCE" and not result["promotion_allowed"]


def test_t22_passing_gate_requires_admin_approval():
    result = evaluate_gate(_metrics("win"), paired_manifest_hash="h", expected_locked_manifest_hash="h")
    assert result["status"] == "V2_WIN"
    assert result["promotion_allowed"] is True
    assert result["requires_human_approval"] is True


def test_manifest_round_trip_keeps_rows_and_file_hash(tmp_path):
    image = tmp_path / "line.png"
    image.write_bytes(b"image")
    row = DatasetRow(str(image), "xin chào", "book-page", "FLOW1_VERIFIED", "train", verified=True)
    path = tmp_path / "manifest.jsonl"
    digest = write_jsonl(path, [row])
    assert load_jsonl(path, expected_flow="FLOW1_VERIFIED") == [row]
    assert len(digest) == 64


def test_checkpoint_shards_round_trip_and_preserve_original(tmp_path):
    source = tmp_path / "candidate.pth"
    payload = bytes(range(251)) * 1000
    source.write_bytes(payload)
    manifest = shard_file(source, tmp_path / "shards", chunk_bytes=10_000)
    assembled = tmp_path / "assembled.pth"
    digest = assemble_shards(manifest, tmp_path / "shards", assembled)
    assert assembled.read_bytes() == payload
    assert digest == manifest["sha256"]
    with pytest.raises(FileExistsError):
        assemble_shards(manifest, tmp_path / "shards", source)


def test_corrupt_checkpoint_shard_is_rejected(tmp_path):
    source = tmp_path / "candidate.pth"
    source.write_bytes(b"candidate bytes")
    manifest = shard_file(source, tmp_path / "shards", chunk_bytes=5)
    (tmp_path / "shards" / manifest["chunks"][0]["name"]).write_bytes(b"bad")
    with pytest.raises(ValueError, match="integrity"):
        assemble_shards(manifest, tmp_path / "shards", tmp_path / "assembled.pth")


def test_t23_locked_test_registration_requires_human_verified_source(tmp_path):
    image = tmp_path / "locked.png"
    image.write_bytes(b"image-bytes")
    source = tmp_path / "locked.json"
    source.write_text(json.dumps([{"sample_id": "sample-1", "group_id": "book-page-1",
                                   "image": str(image), "label": "Xin chào",
                                   "annotation_id": "review-1"}]), encoding="utf-8")
    with pytest.raises(ValueError, match="verified reference"):
        _locked_test_rows(source)


def test_t24_trdg_provenance_must_be_explicit_and_unique(tmp_path):
    image = tmp_path / "synthetic.png"
    provenance = tmp_path / "provenance.json"
    provenance.write_text(json.dumps([{"image": str(image), "generator": "trdg", "seed": 7}]), encoding="utf-8")
    assert _read_trdg_provenance(provenance)[str(image.resolve())]["seed"] == 7
    provenance.write_text(json.dumps([{"image": str(image), "generator": "unknown"}]), encoding="utf-8")
    with pytest.raises(ValueError, match="TRDG generator"):
        _read_trdg_provenance(provenance)


def test_t25_public_training_profiles_map_to_separate_legacy_dataset_sources():
    assert PROFILES["FLOW1_EXTERNAL_TRDG"]["flows"] == {"FLOW2_EXTERNAL", "FLOW2_TRDG"}
    assert PROFILES["FLOW2_ADMIN_VERIFIED"]["flows"] == {"FLOW1_VERIFIED"}
    assert PROFILES["FLOW1_EXTERNAL_TRDG"]["flows"].isdisjoint(PROFILES["FLOW2_ADMIN_VERIFIED"]["flows"])


def test_t28_flow1_enforces_the_real_and_synthetic_sample_ranges():
    validate_flow1_sample_counts({"FLOW2_EXTERNAL": 500, "FLOW2_TRDG": 20_000})
    validate_flow1_sample_counts({"FLOW2_EXTERNAL": 1_000, "FLOW2_TRDG": 50_000})
    with pytest.raises(ValueError, match="500-1,000 real and 20,000-50,000 TRDG"):
        validate_flow1_sample_counts({"FLOW2_EXTERNAL": 499, "FLOW2_TRDG": 20_000})
    with pytest.raises(ValueError, match="500-1,000 real and 20,000-50,000 TRDG"):
        validate_flow1_sample_counts({"FLOW2_EXTERNAL": 1_001, "FLOW2_TRDG": 20_000})
    with pytest.raises(ValueError, match="500-1,000 real and 20,000-50,000 TRDG"):
        validate_flow1_sample_counts({"FLOW2_EXTERNAL": 500, "FLOW2_TRDG": 50_001})


def test_t29_colab_resume_defaults_start_a_fresh_run_without_a_checkpoint(tmp_path):
    checkpoint = tmp_path / "latest.pt"
    assert _should_resume(True, checkpoint, tmp_path) is False
    checkpoint.write_bytes(b"checkpoint")
    assert _should_resume(True, checkpoint, tmp_path) is True


def test_t30_resume_refuses_best_weights_without_the_matching_training_state(tmp_path):
    (tmp_path / "best-example.pth").write_bytes(b"best weights")
    with pytest.raises(FileNotFoundError, match="resumable checkpoint is missing"):
        _should_resume(True, tmp_path / "latest.pt", tmp_path)


def test_vietocr_width_bucket_sampler_keeps_partial_batches_without_mixing_widths():
    dataset = types.SimpleNamespace(cluster_indices={
        64: [0, 1, 2],
        96: [3, 4],
        128: [5, 6, 7, 8, 9, 10],
    })
    sampler = _WidthBucketBatchSampler(dataset, batch_size=8, shuffle=False)

    batches = list(sampler)
    assert len(sampler) == 3
    assert [len(batch) for batch in batches] == [3, 2, 6]
    assert sorted(index for batch in batches for index in batch) == list(range(11))
    bucket_for_index = {
        index: bucket
        for bucket, indices in dataset.cluster_indices.items()
        for index in indices
    }
    assert all(len({bucket_for_index[index] for index in batch}) == 1 for batch in batches)


def test_vietocr_width_bucket_sampler_rejects_nonpositive_batch_size():
    dataset = types.SimpleNamespace(cluster_indices={})
    with pytest.raises(ValueError, match="batch size must be positive"):
        _WidthBucketBatchSampler(dataset, batch_size=0)


def test_vietocr_legacy_lmdb_image_validator_supports_numpy_2_bytes(tmp_path, monkeypatch):
    np = pytest.importorskip("numpy")
    cv2 = pytest.importorskip("cv2")
    lmdb = pytest.importorskip("lmdb")
    pillow_image = pytest.importorskip("PIL.Image")
    pytest.importorskip("vietocr")
    import vietocr.tool.create_dataset as vietocr_dataset
    from vietocr.loader import dataloader as vietocr_dataloader

    original_validator = vietocr_dataset.checkImageIsValid
    monkeypatch.setattr(vietocr_dataset, "checkImageIsValid", original_validator)

    original_fromstring = np.fromstring

    def numpy2_fromstring_behavior(value, *args, **kwargs):
        if isinstance(value, (bytes, bytearray, memoryview)) and not kwargs.get("sep", ""):
            raise ValueError("The binary mode of fromstring is removed, use frombuffer instead")
        return original_fromstring(value, *args, **kwargs)

    monkeypatch.setattr(np, "fromstring", numpy2_fromstring_behavior)
    monkeypatch.delattr(pillow_image, "ANTIALIAS", raising=False)
    _install_vietocr_numpy_bytes_compatibility(np, cv2)
    assert pillow_image.ANTIALIAS == pillow_image.Resampling.LANCZOS

    image = np.full((23, 57), 255, dtype=np.uint8)
    encoded_ok, encoded = cv2.imencode(".png", image)
    assert encoded_ok
    image_bytes = encoded.tobytes()
    assert vietocr_dataset.checkImageIsValid(image_bytes) == (True, 23, 57)
    assert vietocr_dataset.checkImageIsValid(b"not an encoded image") == (False, None, None)

    (tmp_path / "line-a.png").write_bytes(image_bytes)
    (tmp_path / "line-b.png").write_bytes(image_bytes)
    (tmp_path / "train.tsv").write_text(
        "line-a.png\tverified label one\nline-b.png\tverified label two\n",
        encoding="utf-8",
    )
    lmdb_path = tmp_path / "train.lmdb"
    vietocr_dataset.createDataset(str(lmdb_path), str(tmp_path), "train.tsv")

    environment = lmdb.open(str(lmdb_path), readonly=True, lock=False, readahead=False)
    try:
        with environment.begin() as transaction:
            assert transaction.get(b"image-000000000") == image_bytes
            assert transaction.get(b"label-000000000") == b"verified label one"
            assert transaction.get(b"image-000000001") == image_bytes
            assert transaction.get(b"label-000000001") == b"verified label two"
    finally:
        environment.close()

    dataset = vietocr_dataloader.OCRDataset(
        lmdb_path=str(lmdb_path),
        root_dir=str(tmp_path),
        annotation_path="train.tsv",
        vocab=types.SimpleNamespace(encode=lambda label: label),
    )
    try:
        assert dataset.nSamples == 2
        assert dataset.get_bucket(0) == 80
        assert dataset.get_bucket(1) == 80
        assert dataset.cluster_indices[80] == [0, 1]
        assert dataset.read_buffer(0)[1:] == ("verified label one", "line-a.png")
        assert dataset.read_buffer(1)[1:] == ("verified label two", "line-b.png")
        assert dataset[0]["word"] == "verified label one"
        assert dataset[1]["word"] == "verified label two"
    finally:
        dataset.env.close()

    from vietocr.model.trainer import Trainer

    trainer = types.SimpleNamespace(
        config={
            "dataset": {"image_height": 32, "image_min_width": 32, "image_max_width": 512},
            "dataloader": {"num_workers": 0},
        },
        vocab=types.SimpleNamespace(encode=lambda _label: np.array([1, 2], dtype=np.int32)),
        batch_size=8,
    )
    train_generator = Trainer.data_gen(trainer, str(lmdb_path), str(tmp_path), "train.tsv")
    try:
        batches = list(train_generator)
        assert len(batches) == 1
        assert batches[0]["img"].shape[0] == 2
        assert len(batches[0]["filenames"]) == 2
    finally:
        train_generator.dataset.env.close()


def test_t26_trdg_supports_multiple_reviewed_fonts_without_changing_ground_truth(tmp_path, monkeypatch):
    pillow = pytest.importorskip("PIL.Image")
    font_a, font_b = tmp_path / "font-a.ttf", tmp_path / "font-b.ttf"
    font_a.write_bytes(b"font-a")
    font_b.write_bytes(b"font-b")

    class FakeGenerator:
        def __init__(self, strings, count, fonts, language):
            self.strings = strings
            self.fonts = fonts

        def __iter__(self):
            yield pillow.new("RGB", (64, 24), "white"), self.strings[0]

    trdg_module = types.ModuleType("trdg")
    generator_module = types.ModuleType("trdg.generators")
    generator_module.GeneratorFromStrings = FakeGenerator
    trdg_module.generators = generator_module
    monkeypatch.setitem(sys.modules, "trdg", trdg_module)
    monkeypatch.setitem(sys.modules, "trdg.generators", generator_module)

    rows, provenance = generate_trdg(texts=["Xin chào"], font=[str(font_a), str(font_b)],
                                     output_dir=tmp_path / "generated", count_per_text=1)
    assert len(rows) == 2
    assert {row.label for row in rows} == {"Xin chào"}
    assert {item["font_sha256"] for item in provenance} == {
        hashlib.sha256(b"font-a").hexdigest(), hashlib.sha256(b"font-b").hexdigest(),
    }


def test_t27_invalid_external_boxes_go_to_review_instead_of_becoming_crops(tmp_path):
    pillow = pytest.importorskip("PIL.Image")
    image = tmp_path / "page.png"
    pillow.new("RGB", (100, 50), "white").save(image)
    annotations = [{"image": str(image), "annotation_id": "ann-1", "group_id": "page-1",
                    "bbox": [10, 10, 120, 30], "label": "Xin chào", "verified": True}]
    rows, review = match_external_annotations(annotations, lambda _path: [[[10, 10], [80, 10], [80, 30], [10, 30]]],
                                              tmp_path / "crops")
    assert rows == []
    assert review[0]["reason"] == "invalid_annotation_box"
