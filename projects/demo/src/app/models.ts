/** Shapes returned by https://jsonplaceholder.typicode.com */

export interface Post {
  userId: number;
  id: number;
  title: string;
  body: string;
}

export interface Comment {
  postId: number;
  id: number;
  name: string;
  email: string;
  body: string;
}

export interface User {
  id: number;
  name: string;
  username: string;
  email: string;
}

/** A locally-created post. JSONPlaceholder does not persist writes, so we keep them here. */
export interface LocalPost extends Post {
  /** Marks rows that only exist in the browser. */
  local?: boolean;
}
