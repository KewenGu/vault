import type { Metadata } from "next";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "传照片或文件" };

/**
 * 只传文件的页面：手机上的快捷指令「存入 Vault」里选「传照片或文件」打开这里。
 * 网页不能自己弹出选文件的界面（iOS 要用户点一下），所以是一个大按钮，点了就是系统的选照片 / 选文件 / 拍照。
 */
export default function UploadPage() {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">传照片或文件</h1>
      <UploadForm />
    </div>
  );
}
