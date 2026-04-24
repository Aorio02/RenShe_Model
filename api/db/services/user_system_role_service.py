#
#  Copyright 2024 The InfiniFlow Authors. All Rights Reserved.
#
#  Licensed under the Apache License, Version 2.0 (the "License");
#  you may not use this file except in compliance with the License.
#  You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#  Unless required by applicable law or agreed to in writing, software
#  distributed under the License is distributed on an "AS IS" BASIS,
#  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#  See the License for the specific language governing permissions and
#  limitations under the License.
#
from datetime import datetime

from api.db import SystemRole
from api.db.db_models import DB, UserSystemRole
from api.db.services.common_service import CommonService
from common.constants import StatusEnum
from common.time_utils import current_timestamp, datetime_format


class UserSystemRoleService(CommonService):
    model = UserSystemRole

    @classmethod
    @DB.connection_context()
    def get_role_record_by_user_id(cls, user_id):
        return (
            cls.model.select()
            .where(
                (cls.model.user_id == user_id)
                & (cls.model.status == StatusEnum.VALID.value)
            )
            .first()
        )

    @classmethod
    def get_role_by_user_id(cls, user_id, fallback_is_superuser=False):
        role_record = cls.get_role_record_by_user_id(user_id)
        if role_record and role_record.role:
            return role_record.role

        if fallback_is_superuser:
            return SystemRole.SUPER_ADMIN.value

        return SystemRole.USER.value

    @classmethod
    @DB.connection_context()
    def save_or_update_role(cls, user_id, role):
        role_value = role.value if isinstance(role, SystemRole) else role
        existing = cls.model.select().where(cls.model.user_id == user_id).first()
        if existing:
            cls.model.update(
                {
                    "role": role_value,
                    "status": StatusEnum.VALID.value,
                    "update_time": current_timestamp(),
                    "update_date": datetime_format(datetime.now()),
                }
            ).where(cls.model.id == existing.id).execute()
            return existing.id

        return cls.insert(
            user_id=user_id,
            role=role_value,
            status=StatusEnum.VALID.value,
        )

    @classmethod
    @DB.connection_context()
    def delete_by_user_id(cls, user_id):
        return cls.model.delete().where(cls.model.user_id == user_id).execute()
