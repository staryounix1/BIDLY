import { api } from './auth-api';

/**
 * Upload a file and get back a URL the request can carry.
 *
 * Photos are small after the browser downscales them, so they can ride in the
 * request body as data URLs. A video cannot: the API's JSON parser caps bodies
 * at 1 MB and base64 inflates the file by a third on top. Uploading the bytes
 * here returns a short URL that goes into the request like any other, which is
 * what lets a clip of any size be attached.
 */
export const mediaApi = {
  async upload(file: Blob): Promise<{ id: string; url: string }> {
    const res = await api.upload<{ id: string; url: string }>('/media', file);
    return res.data;
  },
};
