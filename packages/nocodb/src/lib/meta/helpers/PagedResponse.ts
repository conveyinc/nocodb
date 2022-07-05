import { PaginatedType } from 'nocodb-sdk';

export class PagedResponseImpl<T> {
  constructor(
    list: T[],
    {
      limit = 25,
      offset = 0,
      count = null,
      shuffle = 0,
    }: {
      limit?: number;
      offset?: number;
      count?: number;
      shuffle?: number;
    } = {}
  ) {
    if (+shuffle) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    this.list = list;
    if (count !== null) {
      this.pageInfo = { totalRows: +count };
      this.pageInfo.page = offset ? offset / limit + 1 : 1;
      this.pageInfo.pageSize = limit;
      this.pageInfo.isFirstPage =
        this.pageInfo.isFirstPage ?? this.pageInfo.page === 1;
      this.pageInfo.isLastPage =
        this.pageInfo.page ===
        (Math.ceil(this.pageInfo.totalRows / this.pageInfo.pageSize) || 1);
    }
  }

  list: Array<T>;
  pageInfo: PaginatedType;
}
