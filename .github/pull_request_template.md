<!--
Cảm ơn bạn đã đóng góp! Vui lòng điền các phần dưới đây.
Xem AGENTS.md gốc trong ~/.claude/CLAUDE.md để biết workflow đầy đủ.
-->

## Mô tả

<!-- Ngắn gọn: cái gì thay đổi, vì sao. -->

## Loại thay đổi

- [ ] Tính năng mới (feat)
- [ ] Sửa lỗi (fix)
- [ ] Refactor / cleanup
- [ ] Tài liệu (docs)
- [ ] CI / chore
- [ ] Test

## Liên quan đến

<!-- Link tới SPEC, issue, hoặc PR khác (nếu là PR stack). -->
- SPEC: `docs/features/NNNN-<name>/SPEC.md` (nếu có)
- Issue / discussion: #
- Stacked on: # (nếu base không phải `main`)

## Cách test

<!-- Hướng dẫn người review verify thay đổi này. -->
- [ ] Tests tự động (CI sẽ chạy)
- [ ] Manual: ...

## Checklist trước khi merge

- [ ] Build TypeScript pass cả BE và FE
- [ ] Test pass (`cd backend && npm test`)
- [ ] Không có hardcoded secret / log thông tin nhạy cảm
- [ ] Đã cập nhật tài liệu nếu API/UX thay đổi
- [ ] Đã thử trên dev (`docker compose up -d --build app`) nếu thay đổi affect runtime
