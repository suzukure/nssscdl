# Source code

Application source code will live here. Planned areas include web/UI, API, application/domain logic, infrastructure adapters, and shared code.

`index.ts` はApplication Workerの最小ES modules entrypointで、現在はすべてのRequestにHTTP 503を返す。
業務Endpointや成功応答は未実装。開発基盤の技術契約と残りのbootstrapは [config/README.md](../config/README.md) を参照する。
