# DPAS Migration Learning Tree

`clip968/dpas-migration` 저장소 안의 interactive learning map입니다. kernel 용어와 I/O path 중심으로 DPAS migration을 따라갑니다.

- **Live site**: https://clip968.github.io/dpas-migration/
- **Repo**: https://github.com/clip968/dpas-migration

## 로컬 실행

```bash
cd learning-tree
npm install
npm run dev
```

## 배포

`dpas-migration` 저장소의 `main`에 `learning-tree/` 변경을 push하면 루트의 GitHub Actions(`.github/workflows/publish-learning-tree.yml`)가 빌드 후 GitHub Pages에 배포합니다.

```bash
# repo root (DPAS_FAST26)
git add learning-tree .github/workflows/publish-learning-tree.yml
git commit -m "update learning tree"
git push origin main
```

GitHub 저장소 Settings → Pages에서 Source가 **GitHub Actions**인지 확인하세요.

## 범위

이 앱은 `learning-tree/` 폴더에만 있습니다. `src/linux-upstream/` 같은 대용량 kernel tree는 이 저장소에 push하지 않습니다.
